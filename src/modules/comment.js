// 评论模块：只读直连 Twikoo 的 D1，改/删转发 Twikoo 事件接口（保留其 XSS 消毒、垃圾检测等逻辑）。
// 读公开；改/删需 token（环境变量 TWIKOO_KEY，请求头 X-Twikoo-Key 或 ?token=）。
// 转发写操作时，用 TWIKOO_ADMIN_TOKEN（= md5(Twikoo 管理密码)）作为 accessToken 冒充管理员。

const TABLE = "comment";
// Twikoo 的页面访问计数表（url / title / time / created / updated）
const COUNTER_TABLE = "counter";
const COUNTER_TITLE_MAX = 200;
// Twikoo 部署地址（评论事件接口）
const TWIKOO_BASE = "https://twikoo.lovlin.cn";

// 统一成站内相对路径（cleanUrls 下文章地址不带 .html）
function normalizeCounterUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let path = raw;
  try {
    path = new URL(raw, "https://blog.lovlin.cn").pathname;
  } catch {
    path = raw.split(/[?#]/)[0];
  }
  path = path.split(/[?#]/)[0].slice(0, COUNTER_TITLE_MAX);
  if (!path.startsWith("/")) return "";
  return path;
}

// 从请求中提取鉴权 token（请求头优先，其次 query）
function getToken(c) {
  const header = c.req.header("X-Twikoo-Key");
  if (header) return header.trim();
  return String(c.req.query("token") || "").trim();
}

// 校验 api-server 侧 token：TWIKOO_KEY 未配置时写操作放行（本地开发）
function isAuthorized(c) {
  const required = String(c.env?.TWIKOO_KEY || "").trim();
  if (!required) return true;
  return getToken(c) === required;
}

// 把 D1 行转成 API 返回结构（只暴露公开字段，隐藏 ip/mail 等敏感信息）
function rowToDto(row) {
  if (!row) return null;
  return {
    id: row._id,
    nick: row.nick || "",
    comment: row.comment || "",
    url: row.url || "",
    link: row.link || "",
    avatar: row.avatar || "",
    isSpam: !!row.isSpam,
    master: !!row.master,
    top: !!row.top,
    like: (() => {
      try {
        return JSON.parse(row.like || "[]");
      } catch {
        return [];
      }
    })(),
    created: row.created || 0,
    updated: row.updated || 0,
  };
}

// 转发写操作到 Twikoo 事件接口
async function forwardToTwikoo(c, event, extra = {}) {
  const adminToken = String(c.env?.TWIKOO_ADMIN_TOKEN || "").trim();
  if (!adminToken) {
    return {
      success: false,
      message: "未配置 TWIKOO_ADMIN_TOKEN，无法转发写操作",
    };
  }
  const body = {
    event,
    accessToken: adminToken,
    ...extra,
  };
  const res = await fetch(TWIKOO_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return json;
}

// GET /v1/comment —— 只读列表（直连 D1，快）
export async function handleList(c) {
  const db = c.env?.TWIKOO_DB;
  if (!db) return c.json({ success: false, message: "数据库未配置" }, 500);

  try {
    const limitRaw = parseInt(c.req.query("limit"), 10);
    const offsetRaw = parseInt(c.req.query("offset"), 10);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 50;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const url = String(c.req.query("url") || "").trim();

    let sql = `SELECT * FROM ${TABLE}`;
    const params = [];
    // 只返回非垃圾评论（isSpam = 0）
    const conditions = ["isSpam = 0"];
    if (url) {
      conditions.push("url = ?");
      params.push(url);
    }
    sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += ` ORDER BY created DESC LIMIT ? OFFSET ?`;
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

// GET /v1/comment/:id —— 单条（直连 D1）
export async function handleGet(c) {
  const db = c.env?.TWIKOO_DB;
  if (!db) return c.json({ success: false, message: "数据库未配置" }, 500);

  try {
    const id = c.req.param("id");
    if (!id) return c.json({ success: false, message: "无效的 id" }, 400);

    const row = await db
      .prepare(`SELECT * FROM ${TABLE} WHERE _id = ?`)
      .bind(id)
      .first();
    if (!row) return c.json({ success: false, message: "评论不存在" }, 404);
    return c.json({ success: true, data: rowToDto(row) });
  } catch (e) {
    return c.json({ success: false, message: String(e?.message || e) }, 500);
  }
}

// PUT /v1/comment/:id —— 修改（转发 Twikoo COMMENT_SET_FOR_ADMIN）
export async function handleUpdate(c) {
  if (!isAuthorized(c))
    return c.json({ success: false, message: "未授权" }, 401);

  const id = c.req.param("id");
  if (!id) return c.json({ success: false, message: "无效的 id" }, 400);

  const body = await c.req.json().catch(() => ({}));
  const set = body?.set || {};
  if (Object.keys(set).length === 0) {
    return c.json({ success: false, message: "set 字段不能为空" }, 400);
  }

  const result = await forwardToTwikoo(c, "COMMENT_SET_FOR_ADMIN", { id, set });
  if (result?.code === 0) {
    return c.json({ success: true, data: { id } });
  }
  return c.json(
    {
      success: false,
      message: result?.message || "修改失败",
      code: result?.code,
    },
    result?.code === 2001 ? 401 : 500,
  );
}

// DELETE /v1/comment/:id —— 删除（转发 Twikoo COMMENT_DELETE_FOR_ADMIN）
export async function handleDelete(c) {
  if (!isAuthorized(c))
    return c.json({ success: false, message: "未授权" }, 401);

  const id = c.req.param("id");
  if (!id) return c.json({ success: false, message: "无效的 id" }, 400);

  const result = await forwardToTwikoo(c, "COMMENT_DELETE_FOR_ADMIN", { id });
  if (result?.code === 0) {
    return c.json({ success: true, data: { id } });
  }
  return c.json(
    {
      success: false,
      message: result?.message || "删除失败",
      code: result?.code,
    },
    result?.code === 2001 ? 401 : 500,
  );
}

// PUT /v1/comment/counter —— 校正 counter 表的页面标题。
// Twikoo 只在首次记录某个 url 时写 title，之后改文章标题它不会更新，
// 这里直接改它库里的 title（只动已存在的记录，不动 time）。
export async function handleSyncCounterTitle(c) {
  if (!isAuthorized(c))
    return c.json({ success: false, message: "未授权" }, 401);

  const db = c.env?.TWIKOO_DB;
  if (!db) return c.json({ success: false, message: "评论数据库未绑定" }, 500);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ success: false, message: "请求体需为 JSON" }, 400);
  }

  // 支持单条 { url, title }，也支持批量 { items: [{ url, title }] }
  const rawItems = Array.isArray(body.items) ? body.items : [body];
  if (rawItems.length === 0) {
    return c.json({ success: false, message: "items 不能为空" }, 400);
  }
  if (rawItems.length > 200) {
    return c.json({ success: false, message: "一次最多同步 200 条" }, 400);
  }

  const items = [];
  for (const raw of rawItems) {
    const url = normalizeCounterUrl(raw?.url);
    const title = String(raw?.title || "")
      .trim()
      .replace(/\s+/g, " ");
    if (!url) {
      return c.json(
        { success: false, message: `url 不合法：${raw?.url ?? ""}` },
        400,
      );
    }
    if (!title) {
      return c.json({ success: false, message: `title 不能为空：${url}` }, 400);
    }
    if (title.length > COUNTER_TITLE_MAX) {
      return c.json({ success: false, message: `title 过长：${url}` }, 400);
    }
    items.push({ url, title });
  }

  try {
    const now = Date.now();
    // WHERE 带 title <> ?：标题没变时不产生写入
    const results = await db.batch(
      items.map((it) =>
        db
          .prepare(
            `UPDATE ${COUNTER_TABLE} SET title = ?, updated = ? WHERE url = ? AND title <> ?`,
          )
          .bind(it.title, now, it.url, it.title),
      ),
    );
    const changed = results.reduce(
      (sum, r) => sum + (Number(r?.meta?.changes) || 0),
      0,
    );
    return c.json({
      success: true,
      data: {
        total: items.length,
        changed,
        unchanged: items.length - changed,
      },
    });
  } catch (e) {
    return c.json({ success: false, message: String(e?.message || e) }, 500);
  }
}

export const meta = {
  name: "Twikoo",
  description: "评论管理（读 D1 存储，改/删转发 Twikoo），读公开改删需 token",
  endpoints: [
    {
      method: "GET",
      path: "",
      description: "评论列表",
      params: "?url=&limit=50&offset=0",
    },
    { method: "GET", path: "/:id", description: "单条评论", params: ":id" },
    {
      method: "PUT",
      path: "/:id",
      description: "修改评论",
      params: "token 鉴权，转发 Twikoo",
    },
    {
      method: "DELETE",
      path: "/:id",
      description: "删除评论",
      params: "token 鉴权，转发 Twikoo",
    },
    {
      method: "PUT",
      path: "/counter",
      description: "校正 counter 表的页面标题",
      params: "token 鉴权，body: { url, title } 或 { items: [{ url, title }] }",
    },
  ],
};
