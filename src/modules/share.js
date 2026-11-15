// 分享（说说）模块：完整 CRUD，数据存 D1（binding: SHARE_DB）。
// 读公开，写操作需 token（环境变量 SHARE_TOKEN，请求头 X-Share-Token 或 ?token=）。

const TABLE = "shares";

// 建表 SQL（首次访问时若表不存在则自动建）
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    device TEXT,
    text TEXT NOT NULL,
    images TEXT,
    location TEXT,
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
  const header = c.req.header("X-Share-Token");
  if (header) return header.trim();
  return String(c.req.query("token") || "").trim();
}

// 校验 token：环境变量 SHARE_TOKEN 未配置时，写操作默认放行（本地开发），
// 线上务必配置，否则任何人都能增删改。
function isAuthorized(c) {
  const required = String(c.env?.SHARE_TOKEN || "").trim();
  if (!required) return true;
  return getToken(c) === required;
}

// 把数据库行转成 API 返回结构（images 存的是 JSON 字符串/数字，还原）
function rowToDto(row) {
  if (!row) return null;
  let images = row.images;
  if (typeof images === "string" && images !== "") {
    try {
      images = JSON.parse(images);
    } catch {
      // 数字字符串直接转数字
      const n = Number(images);
      images = Number.isFinite(n) ? n : images;
    }
  }
  return {
    id: row.id,
    date: row.date,
    device: row.device || "",
    text: row.text || "",
    images: images ?? 0,
    location: row.location || "",
    createdAt: row.created_at || null,
  };
}

// 入参 → 落库字段
function normalizeInput(body) {
  const date = String(body?.date || "").trim();
  const text = String(body?.text || "").trim();
  const device = String(body?.device || "").trim();
  const location = String(body?.location || "").trim();
  const images = body?.images ?? 0;
  return { date, text, device, location, images };
}

export async function handleList(c) {
  const db = c.env?.SHARE_DB;
  if (!db) return c.json({ success: false, message: "数据库未配置" }, 500);

  try {
    await ensureSchema(db);
    const limitRaw = parseInt(c.req.query("limit"), 10);
    const offsetRaw = parseInt(c.req.query("offset"), 10);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 100;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

    const { results } = await db
      .prepare(`SELECT * FROM ${TABLE} ORDER BY date DESC LIMIT ? OFFSET ?`)
      .bind(limit, offset)
      .all();

    const list = (results || []).map(rowToDto);
    return c.json({ success: true, total: list.length, data: list });
  } catch (e) {
    return c.json({ success: false, message: String(e?.message || e) }, 500);
  }
}

export async function handleGet(c) {
  const db = c.env?.SHARE_DB;
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
    if (!row) return c.json({ success: false, message: "分享不存在" }, 404);
    return c.json({ success: true, data: rowToDto(row) });
  } catch (e) {
    return c.json({ success: false, message: String(e?.message || e) }, 500);
  }
}

export async function handleCreate(c) {
  if (!isAuthorized(c))
    return c.json({ success: false, message: "未授权" }, 401);
  const db = c.env?.SHARE_DB;
  if (!db) return c.json({ success: false, message: "数据库未配置" }, 500);

  try {
    await ensureSchema(db);
    const { date, text, device, location, images } = normalizeInput(
      await c.req.json(),
    );
    if (!date || !text) {
      return c.json({ success: false, message: "date 和 text 必填" }, 400);
    }

    const imagesJson =
      typeof images === "string" ? images : JSON.stringify(images ?? 0);
    const now = Date.now();
    const result = await db
      .prepare(
        `INSERT INTO ${TABLE} (date, device, text, images, location, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(date, device, text, imagesJson, location, now)
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
  const db = c.env?.SHARE_DB;
  if (!db) return c.json({ success: false, message: "数据库未配置" }, 500);

  try {
    await ensureSchema(db);
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id))
      return c.json({ success: false, message: "无效的 id" }, 400);

    const { date, text, device, location, images } = normalizeInput(
      await c.req.json(),
    );
    const imagesJson =
      typeof images === "string" ? images : JSON.stringify(images ?? 0);

    const result = await db
      .prepare(
        `UPDATE ${TABLE} SET date = ?, device = ?, text = ?, images = ?, location = ? WHERE id = ?`,
      )
      .bind(date, device, text, imagesJson, location, id)
      .run();

    if (!result.meta?.changes)
      return c.json({ success: false, message: "分享不存在" }, 404);
    return c.json({ success: true, data: { id } });
  } catch (e) {
    return c.json({ success: false, message: String(e?.message || e) }, 500);
  }
}

export async function handleDelete(c) {
  if (!isAuthorized(c))
    return c.json({ success: false, message: "未授权" }, 401);
  const db = c.env?.SHARE_DB;
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
      return c.json({ success: false, message: "分享不存在" }, 404);
    return c.json({ success: true, data: { id } });
  } catch (e) {
    return c.json({ success: false, message: String(e?.message || e) }, 500);
  }
}

export const meta = {
  name: "分享",
  description: "日常分享（说说），D1 存储，读公开写需 token",
  endpoints: [
    {
      method: "GET",
      path: "/",
      description: "分享列表",
      params: "?limit=100&offset=0",
    },
    { method: "GET", path: "/:id", description: "单条分享", params: ":id" },
    {
      method: "POST",
      path: "/",
      description: "新增分享",
      params: "token 鉴权",
    },
    {
      method: "PUT",
      path: "/:id",
      description: "修改分享",
      params: "token 鉴权",
    },
    {
      method: "DELETE",
      path: "/:id",
      description: "删除分享",
      params: "token 鉴权",
    },
  ],
};
