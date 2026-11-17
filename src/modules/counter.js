// 页面标题同步：Twikoo 的 counter 表只在首次记录某个 url 时写入 title，
// 之后改了文章标题不会自动更新（访问只增加 time）。
// 这里提供一个校正入口，由前端页面加载时调用，只改标题不动计数。
// 读写公开——只影响已存在记录的 title 文本，不存在的 url 不会被插入。

const TABLE = "counter";
const MAX_TITLE_LENGTH = 200;

// 统一成站内相对路径（cleanUrls 下文章地址不带 .html）
function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let path = raw;
  try {
    path = new URL(raw, "https://blog.lovlin.cn").pathname;
  } catch {
    path = raw.split(/[?#]/)[0];
  }
  path = path.split(/[?#]/)[0].slice(0, MAX_TITLE_LENGTH);
  if (!path.startsWith("/")) return "";
  return path;
}

// POST /v1/counter/title   body: { url, title }
export async function handleSyncTitle(c) {
  const db = c.env?.TWIKOO_DB;
  if (!db) return c.json({ success: false, message: "评论数据库未绑定" }, 500);

  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, message: "请求体需为 JSON" }, 400);
  }

  const url = normalizeUrl(body?.url);
  const title = String(body?.title || "")
    .trim()
    .replace(/\s+/g, " ");

  if (!url) return c.json({ success: false, message: "url 不合法" }, 400);
  if (!title) return c.json({ success: false, message: "title 不能为空" }, 400);
  if (title.length > MAX_TITLE_LENGTH) {
    return c.json({ success: false, message: "title 过长" }, 400);
  }

  try {
    // WHERE 里带 title <> ?：标题没变时不产生写入
    const result = await db
      .prepare(
        `UPDATE ${TABLE} SET title = ?, updated = ? WHERE url = ? AND title <> ?`,
      )
      .bind(title, Date.now(), url, title)
      .run();

    return c.json({
      success: true,
      data: {
        url,
        title,
        changed: (result?.meta?.changes ?? 0) > 0,
      },
    });
  } catch (e) {
    return c.json({ success: false, message: String(e?.message || e) }, 500);
  }
}

export const meta = {
  name: "标题同步",
  description: "校正 Twikoo counter 表的页面标题，改写公开",
  endpoints: [
    {
      method: "POST",
      path: "/title",
      description: "同步页面标题",
      params: "body: { url, title }",
    },
  ],
};
