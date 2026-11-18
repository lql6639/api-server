// 站点统计模块：PV / UV 存 D1（binding: STATS_DB），自建，不依赖第三方统计服务。
// 读公开；上报（POST）公开，由浏览器侧调用。
// UV 口径：IPv4 取 /24、IPv6 取 /48 后与 UA 拼接做 SHA-256，同一网段同一 UA 视为同一访客。

import { getClientIp, isIP, ipv4Prefix24, ipv6Prefix48 } from "../lib/ip.js";
import { queryIpInfoWithRetry } from "./ipinfo.js";

const SITE_TABLE = "stats_site";
const PAGE_TABLE = "stats_pages";
const VISITOR_TABLE = "stats_visitors";

// 归属地查不到时的重试间隔：太短会每次访问都外呼一次，太长又补不上
const GEO_RETRY_MS = 24 * 60 * 60 * 1000;

// 时间统一按东八区存
// 必须带 +08:00：不带偏移的字符串会被各运行时按自己的时区解释，
// Worker 跑在 UTC 下会把 04:01 当成 UTC，凭空产生 8 小时偏差。
function nowInChina() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().replace(/\.\d{3}Z$/, "+08:00");
}

// 建表语句只对空库生效，已存在的表不会被改成这里的结构。
// 要改表结构就手动在远程库迁移（ALTER / 重建），不在这里维护第二份列定义。
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
    country TEXT NOT NULL DEFAULT '',
    province TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    isp TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    lon TEXT NOT NULL DEFAULT '',
    lat TEXT NOT NULL DEFAULT '',
    device TEXT NOT NULL DEFAULT '',
    os TEXT NOT NULL DEFAULT '',
    browser TEXT NOT NULL DEFAULT '',
    first_path TEXT NOT NULL DEFAULT '',
    last_path TEXT NOT NULL DEFAULT '',
    visits INTEGER NOT NULL DEFAULT 0
  )`,
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
  schemaReady = true;
}

// 从 UA 里扒设备 / 系统 / 浏览器，够看就行，不引第三方库
function parseUa(ua) {
  const s = String(ua || "");
  const isTablet = /iPad|Tablet/i.test(s);
  const isMobile = /Mobile|Android|iPhone|iPod|HarmonyOS|Windows Phone/i.test(
    s,
  );
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
  // visitor 按网段算（UV 口径），完整 IP 另外存一列
  return { visitor, ip };
}

function readNumber(result) {
  const row = result?.results?.[0];
  return Number(row?.pv ?? row?.uv ?? 0) || 0;
}

// 归属地：复用 ipinfo 的多上游查询（自带缓存）。
// 不能走 HTTP 调自己的 /v1/ipinfo —— Cloudflare 不允许 Worker 调自己（522）。
async function fillVisitorGeo(db, visitor, ip) {
  let d;
  try {
    const info = await queryIpInfoWithRetry(ip);
    d = info?.data || {};
  } catch {
    // 归属地查不到不影响统计本身
    return;
  }

  const pick = (value, len) => String(value ?? "").slice(0, len);
  const geo = {
    country: pick(d.country, 20),
    province: pick(d.prov, 40),
    city: pick(d.city, 40),
    isp: pick(d.isp, 60),
    lon: pick(d.lon, 20),
    lat: pick(d.lat, 20),
  };
  if (!geo.country && !geo.province && !geo.city && !geo.isp) return;

  try {
    await db
      .prepare(
        `UPDATE ${VISITOR_TABLE}
            SET country = ?, province = ?, city = ?, isp = ?, lon = ?, lat = ?
          WHERE visitor = ?`,
      )
      .bind(
        geo.country,
        geo.province,
        geo.city,
        geo.isp,
        geo.lon,
        geo.lat,
        visitor,
      )
      .run();
  } catch {
    // 同上，写失败就算了
  }
}

async function readStats(db, path) {
  const statements = [
    db.prepare(`SELECT pv FROM ${SITE_TABLE} WHERE id = 1`),
    db.prepare(`SELECT COUNT(*) AS uv FROM ${VISITOR_TABLE}`),
  ];
  if (path) {
    statements.push(
      db.prepare(`SELECT pv FROM ${PAGE_TABLE} WHERE path = ?`).bind(path),
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
  const now = nowInChina();
  const { visitor, ip } = await buildVisitorId(c.req.raw);
  const { device, os, browser } = parseUa(ua);
  // Cloudflare 边缘带上来的国家代码，只作为归属地查不到时的兜底
  const cfCountry = c.req.raw.cf?.country || c.req.header("cf-ipcountry") || "";

  // 先读旧记录：决定要不要补归属地，同时给下面判定「上次是什么时候来的」用
  const existing = await db
    .prepare(
      `SELECT country, province, lon, last_seen
         FROM ${VISITOR_TABLE} WHERE visitor = ?`,
    )
    .bind(visitor)
    .first();

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
      // country 只在还没值时用边缘国家码兜底，否则会把 geo 查到的中文名覆盖成两位码
      db
        .prepare(
          `INSERT INTO ${VISITOR_TABLE}
             (visitor, first_seen, last_seen, ip, country, device, os, browser, visits, first_path, last_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(visitor) DO UPDATE SET
             last_seen = excluded.last_seen,
             last_path = excluded.last_path,
             ip = excluded.ip,
             country = CASE WHEN ${VISITOR_TABLE}.country = ''
                            THEN excluded.country
                            ELSE ${VISITOR_TABLE}.country END,
             device = excluded.device,
             os = excluded.os,
             browser = excluded.browser,
             visits = visits + 1`,
        )
        .bind(
          visitor,
          now,
          now,
          ip,
          cfCountry,
          device,
          os,
          browser,
          path,
          path,
        ),
    ]);
  } catch (error) {
    return c.json({ error: `统计写入失败：${error?.message || error}` }, 500);
  }

  // 归属地不全才补：新访客直接查；老记录缺省市/经纬度时，一天最多重试一次，
  // 否则上游一直查不到就会每次访问都外呼一遍
  const hasGeo =
    !!existing?.province &&
    !!existing?.lon &&
    !/^[A-Z]{2}$/.test(String(existing?.country || ""));
  const lastSeenAt = Date.parse(existing?.last_seen || "") || 0;
  const retryDue = !existing || Date.now() - lastSeenAt > GEO_RETRY_MS;

  if (!hasGeo && retryDue) {
    const task = fillVisitorGeo(db, visitor, ip);
    try {
      c.executionCtx.waitUntil(task);
    } catch {
      // 没有 executionCtx（例如测试里直接调用）就让它自己跑完，失败也无妨
      task.catch(() => {});
    }
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
