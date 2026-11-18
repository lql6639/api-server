// 站点统计模块：PV / UV 存 D1（binding: STATS_DB），自建，不依赖第三方统计服务。
// 读公开；上报（POST）公开，由浏览器侧调用。
// UV 口径：IPv4 取 /24、IPv6 取 /48 后与 UA 拼接做 SHA-256，同一网段同一 UA 视为同一访客。

import { getClientIp, isIP, ipv4Prefix24, ipv6Prefix48 } from "../lib/ip.js";
import { queryIpInfoWithRetry } from "./ipinfo.js";

const SITE_TABLE = "stats_site";
const PAGE_TABLE = "stats_pages";
const VISITOR_TABLE = "stats_visitors";

// 时间统一按东八区存，形如 2026-11-19T04:01:48+08:00。
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
  // 一次访问一行：同一访客来几次就有几行。
  // 主键用 (visitor, visits)：visitor 单独做不了主键（同一人会重复），
  // visits 是「这是第几次访问」，两者组合天然唯一，也不用额外加自增 id。
  `CREATE TABLE IF NOT EXISTS ${VISITOR_TABLE} (
    visitor TEXT NOT NULL DEFAULT '',
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
    visits INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (visitor, visits)
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
// 一次访问一行之后，只补写刚插入的那一行（visitor + visits 定位）。
async function fillVisitorGeo(db, visitor, visits, ip) {
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
          WHERE visitor = ? AND visits = ?`,
      )
      .bind(
        geo.country,
        geo.province,
        geo.city,
        geo.isp,
        geo.lon,
        geo.lat,
        visitor,
        visits,
      )
      .run();
  } catch {
    // 同上，写失败就算了
  }
}

async function readStats(db, path) {
  const statements = [
    db.prepare(`SELECT pv FROM ${SITE_TABLE} WHERE id = 1`),
    // 一人多行了，访客数不能再按行数算
    db.prepare(
      `SELECT COUNT(DISTINCT visitor) AS uv FROM ${VISITOR_TABLE}`,
    ),
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

  // 上一次访问那一行：序号接着往上加；归属地也从这行抄，不用每次外呼
  const prev = await db
    .prepare(
      `SELECT country, province, city, isp, lon, lat, first_path, visits
         FROM ${VISITOR_TABLE} WHERE visitor = ?
        ORDER BY visits DESC LIMIT 1`,
    )
    .bind(visitor)
    .first();

  const visits = Number(prev?.visits || 0) + 1;
  // 这行已经带着完整归属地，就不用再查一次
  const reusedGeo = !!(prev?.province && prev?.lon);
  const geo = reusedGeo
    ? prev
    : { country: cfCountry, province: "", city: "", isp: "", lon: "", lat: "" };

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
      // 一次访问一行，只追加不覆盖
      db
        .prepare(
          `INSERT INTO ${VISITOR_TABLE}
             (visitor, last_seen, country, province, city, isp, ip, lon, lat,
              device, os, browser, first_path, last_path, visits)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          visitor,
          now,
          geo.country,
          geo.province,
          geo.city,
          geo.isp,
          ip,
          geo.lon,
          geo.lat,
          device,
          os,
          browser,
          prev?.first_path || path,
          path,
          visits,
        ),
    ]);
  } catch (error) {
    return c.json({ error: `统计写入失败：${error?.message || error}` }, 500);
  }

  // 全新访客（或者上一行归属地就是空的）才去查一次，写完只更新刚插入的那行
  if (!reusedGeo) {
    const task = fillVisitorGeo(db, visitor, visits, ip);
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
