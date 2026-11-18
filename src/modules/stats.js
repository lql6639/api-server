// 站点统计模块：PV / UV 存 D1（binding: STATS_DB），自建，不依赖第三方统计服务。
// 读公开；上报（POST）公开，由浏览器侧调用。
// UV 口径：IPv4 取 /24、IPv6 取 /48 后与 UA 拼接做 SHA-256，同一网段同一 UA 视为同一访客。

import { getClientIp, isIP, ipv4Prefix24, ipv6Prefix48 } from "../lib/ip.js";

const SITE_TABLE = "stats_site";
const PAGE_TABLE = "stats_pages";
const VISITOR_TABLE = "stats_visitors";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${SITE_TABLE} (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pv INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS ${PAGE_TABLE} (
    path TEXT PRIMARY KEY,
    pv INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS ${VISITOR_TABLE} (
    visitor TEXT PRIMARY KEY,
    first_seen TEXT NOT NULL DEFAULT '',
    last_seen TEXT NOT NULL DEFAULT '',
    ip_prefix TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    device TEXT NOT NULL DEFAULT '',
    os TEXT NOT NULL DEFAULT '',
    browser TEXT NOT NULL DEFAULT '',
    visits INTEGER NOT NULL DEFAULT 0,
    first_path TEXT NOT NULL DEFAULT '',
    last_path TEXT NOT NULL DEFAULT ''
  )`,
];

// 老库补列：CREATE TABLE IF NOT EXISTS 不会改动已存在的表
const VISITOR_EXTRA_COLUMNS = [
  ["ip_prefix", "TEXT NOT NULL DEFAULT ''"],
  ["country", "TEXT NOT NULL DEFAULT ''"],
  ["device", "TEXT NOT NULL DEFAULT ''"],
  ["os", "TEXT NOT NULL DEFAULT ''"],
  ["browser", "TEXT NOT NULL DEFAULT ''"],
  ["visits", "INTEGER NOT NULL DEFAULT 0"],
  ["first_path", "TEXT NOT NULL DEFAULT ''"],
  ["last_path", "TEXT NOT NULL DEFAULT ''"],
];

// 爬虫/预渲染/命令行 UA 不计入，避免污染数据
const BOT_UA =
  /(bot|spider|crawler|slurp|bingpreview|headless|phantom|curl|wget|python-requests|axios\/|okhttp|go-http-client|preview)/i;

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady || !db) return;
  for (const statement of SCHEMA) {
    await db.prepare(statement).run();
  }
  // 已存在的表不会因为 CREATE TABLE IF NOT EXISTS 而变结构，缺的列单独补
  const { results } = await db
    .prepare(`PRAGMA table_info(${VISITOR_TABLE})`)
    .all();
  const existing = new Set((results || []).map((row) => row.name));
  for (const [name, def] of VISITOR_EXTRA_COLUMNS) {
    if (!existing.has(name)) {
      await db
        .prepare(`ALTER TABLE ${VISITOR_TABLE} ADD COLUMN ${name} ${def}`)
        .run();
    }
  }
  schemaReady = true;
}

// 从 UA 里扒设备 / 系统 / 浏览器，够看就行，不引第三方库
function parseUa(ua) {
  const s = String(ua || "");
  const isTablet = /iPad|Tablet/i.test(s);
  const isMobile = /Mobile|Android|iPhone|iPod|HarmonyOS|Windows Phone/i.test(s);
  const device = isTablet ? "tablet" : isMobile ? "mobile" : "desktop";

  let os = "其它";
  if (/Windows NT/i.test(s)) os = "Windows";
  else if (/iPhone|iPad|iPod/i.test(s)) os = "iOS";
  else if (/Mac OS X/i.test(s)) os = "macOS";
  else if (/Android/i.test(s)) os = "Android";
  else if (/Linux/i.test(s)) os = "Linux";

  let browser = "其它";
  if (/Edg\//i.test(s)) browser = "Edge";
  else if (/OPR\/|Opera/i.test(s)) browser = "Opera";
  else if (/Firefox\//i.test(s)) browser = "Firefox";
  else if (/Chrome\/|CriOS/i.test(s)) browser = "Chrome";
  else if (/Safari\//i.test(s)) browser = "Safari";

  return { device, os, browser };
}

// 统一成站内相对路径，避免把整条带参数的 URL 记成不同页面
function normalizePath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "/";
  let path = raw;
  try {
    // 第二个参数只是解析相对路径用的基准，域名填什么都不影响结果（下面只取 pathname）
    path = new URL(raw, "https://blog.lovlin.cn").pathname;
  } catch {
    path = raw.split(/[?#]/)[0];
  }
  path = path.split(/[?#]/)[0].slice(0, 200);
  if (!path.startsWith("/")) path = `/${path}`;
  return path || "/";
}

async function buildVisitorId(request) {
  const ip = getClientIp(request);
  const kind = isIP(ip);
  const prefix =
    kind === 4 ? ipv4Prefix24(ip) : kind === 6 ? ipv6Prefix48(ip) : ip;
  const ua = request.headers.get("user-agent") || "";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`koizora|${prefix}|${ua}`),
  );
  const visitor = Array.from(new Uint8Array(digest).slice(0, 12))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  // 只留网段，不存完整 IP，能看出大致来源又不至于精确到个人
  return { visitor, ipPrefix: prefix };
}

function readNumber(result) {
  const row = result?.results?.[0];
  return Number(row?.pv ?? row?.uv ?? 0) || 0;
}

async function readStats(db, path) {
  const statements = [
    db.prepare(`SELECT pv FROM ${SITE_TABLE} WHERE id = 1`),
    db.prepare(`SELECT COUNT(*) AS uv FROM ${VISITOR_TABLE}`),
  ];
  if (path) {
    statements.push(
      db
        .prepare(`SELECT pv FROM ${PAGE_TABLE} WHERE path = ?`)
        .bind(path),
    );
  }
  const results = await db.batch(statements);
  const data = {
    site_pv: readNumber(results[0]),
    site_uv: readNumber(results[1]),
  };
  if (path) {
    data.path = path;
    data.page_pv = readNumber(results[2]);
  }
  return data;
}

// GET /v1/stats[?path=/xxx]
export async function handleStats(c) {
  const db = c.env?.STATS_DB;
  if (!db) return c.json({ error: "统计数据库未绑定" }, 500);
  await ensureSchema(db);

  c.header("Cache-Control", "no-store");
  const path = c.req.query("path");
  const data = await readStats(db, path ? normalizePath(path) : "");
  return c.json({ success: true, data });
}

// POST /v1/stats   body: { path }
export async function handleReport(c) {
  const db = c.env?.STATS_DB;
  if (!db) return c.json({ error: "统计数据库未绑定" }, 500);
  await ensureSchema(db);

  const ua = c.req.header("user-agent") || "";
  if (!ua || BOT_UA.test(ua)) {
    return c.json({ success: true, data: { skipped: true } });
  }

  let body = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const path = normalizePath(body?.path ?? c.req.query("path"));
  const now = new Date().toISOString();
  const { visitor, ipPrefix } = await buildVisitorId(c.req.raw);
  const { device, os, browser } = parseUa(ua);
  // Cloudflare 边缘带上来的国家代码，本地开发没有这个值
  const country =
    c.req.raw.cf?.country || c.req.header("cf-ipcountry") || "";

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO ${SITE_TABLE} (id, pv, updated_at) VALUES (1, 1, ?)
           ON CONFLICT(id) DO UPDATE SET pv = pv + 1, updated_at = excluded.updated_at`,
        )
        .bind(now),
      db
        .prepare(
          `INSERT INTO ${PAGE_TABLE} (path, pv, updated_at) VALUES (?, 1, ?)
           ON CONFLICT(path) DO UPDATE SET pv = pv + 1, updated_at = excluded.updated_at`,
        )
        .bind(path, now),
      db
        .prepare(
          `INSERT INTO ${VISITOR_TABLE}
             (visitor, first_seen, last_seen, ip_prefix, country, device, os, browser, visits, first_path, last_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(visitor) DO UPDATE SET
             last_seen = excluded.last_seen,
             last_path = excluded.last_path,
             country = excluded.country,
             device = excluded.device,
             os = excluded.os,
             browser = excluded.browser,
             visits = visits + 1`,
        )
        .bind(visitor, now, now, ipPrefix, country, device, os, browser, path, path),
    ]);
  } catch (error) {
    return c.json({ error: `统计写入失败：${error?.message || error}` }, 500);
  }

  c.header("Cache-Control", "no-store");
  return c.json({ success: true, data: await readStats(db, path) });
}

export const meta = {
  name: "统计",
  description: "站点 PV / UV 统计，数据存 D1，读写均公开",
  endpoints: [
    {
      method: "GET",
      path: "",
      description: "站点统计（总访问量 / 总访客数）",
      params: "?path=/xxx 可选，附带该页面 PV",
    },
    {
      method: "POST",
      path: "",
      description: "上报一次访问",
      params: "body: { path }",
    },
  ],
};
