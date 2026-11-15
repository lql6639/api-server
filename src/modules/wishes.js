// 心愿/树洞模块：数据存 D1（binding: WISHES_DB）。
// 读公开，发布（POST）公开，修改/删除需 token（环境变量 WISHES_TOKEN，请求头 X-Wishes-Token 或 ?token=）。

const TABLE = "wishes";

// 建表 SQL（首次访问时若表不存在则自动建）
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    nickname TEXT,
    color TEXT,
    type TEXT,
    date TEXT,
    created_at INTEGER
  )
`;

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady || !db) return;
  await db.prepare(SCHEMA).run();
  schemaReady = true;
}

// 从请求中提取鉴权 token（请求头优先，其次 query）
function getToken(c) {
  const header = c.req.header("X-Wishes-Token");
  if (header) return header.trim();
  return String(c.req.query("token") || "").trim();
}

// 校验 token：环境变量 WISHES_TOKEN 未配置时，写操作默认放行（本地开发），
// 线上务必配置，否则任何人都能增删改。
function isAuthorized(c) {
  const required = String(c.env?.WISHES_TOKEN || "").trim();
  if (!required) return true;
  return getToken(c) === required;
}

// 把数据库行转成 API 返回结构
function rowToDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    content: row.content || "",
    nickname: row.nickname || "",
    color: row.color || "green",
    type: row.type || "wish",
    date: row.date || "",
    createdAt: row.created_at || null,
  };
}

// 入参 → 落库字段
function normalizeInput(body) {
  const content = String(body?.content || "").trim();
  const nickname = String(body?.nickname || "").trim();
  const color = String(body?.color || "green").trim();
  const type = body?.type === "treehole" ? "treehole" : "wish";
  const date = String(body?.date || "").trim();
  return { content, nickname, color, type, date };
}

export async function handleList(c) {
  const db = c.env?.WISHES_DB;
  if (!db) return c.json({ success: false, message: "数据库未配置" }, 500);

  try {
    await ensureSchema(db);
    const limitRaw = parseInt(c.req.query("limit"), 10);
    const offsetRaw = parseInt(c.req.query("offset"), 10);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 200;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

    // 按 type 过滤（可选）
    const type = String(c.req.query("type") || "").trim();
    let sql = `SELECT * FROM ${TABLE}`;
    const params = [];
    if (type === "wish" || type === "treehole") {
      sql += ` WHERE type = ?`;
      params.push(type);
    }
    sql += ` ORDER BY id DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const { results } = await db
      .prepare(sql)
      .bind(...params)
      .all();
    const list = (results || []).map(rowToDto);
    return c.json({ success: true, total: list.length, data: list });
  } catch (e) {
    return c.json({ success: false, message: String(e?.message || e) }, 500);
  }
}

export async function handleGet(c) {
  const db = c.env?.WISHES_DB;
  if (!db) return c.json({ success: false, message: "数据库未配置" }, 500);

  try {
    await ensureSchema(db);
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id))
      return c.json({ success: false, message: "无效的 id" }, 400);

    const row = await db
      .prepare(`SELECT * FROM ${TABLE} WHERE id = ?`)
      .bind(id)
      .first();
    if (!row) return c.json({ success: false, message: "心愿不存在" }, 404);
    return c.json({ success: true, data: rowToDto(row) });
  } catch (e) {
    return c.json({ success: false, message: String(e?.message || e) }, 500);
  }
}

// 发布：公开，无需 token
export async function handleCreate(c) {
  const db = c.env?.WISHES_DB;
  if (!db) return c.json({ success: false, message: "数据库未配置" }, 500);

  try {
    await ensureSchema(db);
    const { content, nickname, color, type, date } = normalizeInput(
      await c.req.json(),
    );
    if (!content) {
      return c.json({ success: false, message: "content 必填" }, 400);
    }
    // 内容长度限制：50 字（与前端 MAX_LEN 一致）
    if (content.length > 50) {
      return c.json({ success: false, message: "内容最多 50 个字" }, 400);
    }
    if (nickname.length > 10) {
      return c.json({ success: false, message: "昵称最多 10 个字" }, 400);
    }

    const now = Date.now();
    const result = await db
      .prepare(
        `INSERT INTO ${TABLE} (content, nickname, color, type, date, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(content, nickname || "匿名", color, type, date, now)
      .run();

    return c.json({
      success: true,
      data: { id: result.meta?.last_row_id ?? null },
    });
  } catch (e) {
    return c.json({ success: false, message: String(e?.message || e) }, 500);
  }
}

export async function handleUpdate(c) {
  if (!isAuthorized(c))
    return c.json({ success: false, message: "未授权" }, 401);
  const db = c.env?.WISHES_DB;
  if (!db) return c.json({ success: false, message: "数据库未配置" }, 500);

  try {
    await ensureSchema(db);
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id))
      return c.json({ success: false, message: "无效的 id" }, 400);

    const { content, nickname, color, type, date } = normalizeInput(
      await c.req.json(),
    );
    const result = await db
      .prepare(
        `UPDATE ${TABLE} SET content = ?, nickname = ?, color = ?, type = ?, date = ? WHERE id = ?`,
      )
      .bind(content, nickname || "匿名", color, type, date, id)
      .run();

    if (!result.meta?.changes)
      return c.json({ success: false, message: "心愿不存在" }, 404);
    return c.json({ success: true, data: { id } });
  } catch (e) {
    return c.json({ success: false, message: String(e?.message || e) }, 500);
  }
}

export async function handleDelete(c) {
  if (!isAuthorized(c))
    return c.json({ success: false, message: "未授权" }, 401);
  const db = c.env?.WISHES_DB;
  if (!db) return c.json({ success: false, message: "数据库未配置" }, 500);

  try {
    await ensureSchema(db);
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id))
      return c.json({ success: false, message: "无效的 id" }, 400);

    const result = await db
      .prepare(`DELETE FROM ${TABLE} WHERE id = ?`)
      .bind(id)
      .run();
    if (!result.meta?.changes)
      return c.json({ success: false, message: "心愿不存在" }, 404);
    return c.json({ success: true, data: { id } });
  } catch (e) {
    return c.json({ success: false, message: String(e?.message || e) }, 500);
  }
}

export const meta = {
  name: "树洞",
  description: "心愿树洞（心愿/树洞），D1 存储，发布公开改删需 token",
  endpoints: [
    {
      method: "GET",
      path: "",
      description: "心愿列表",
      params: "?limit=200&offset=0&type=wish|treehole",
    },
    { method: "GET", path: "/:id", description: "单条心愿", params: ":id" },
    {
      method: "POST",
      path: "",
      description: "发布心愿（公开）",
      params: "content/nickname/color/type/date",
    },
    {
      method: "PUT",
      path: "/:id",
      description: "修改心愿",
      params: "token 鉴权",
    },
    {
      method: "DELETE",
      path: "/:id",
      description: "删除心愿",
      params: "token 鉴权",
    },
  ],
};
