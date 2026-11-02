import { Hono } from "hono";
import { cors } from "hono/cors";
import * as img from "./modules/img.js";
import * as ipinfo from "./modules/ipinfo.js";
import * as weather from "./modules/weather.js";
import { getClientIp } from "./lib/ip.js";

const PROJECT_NAME = "API Server";
const API_DIR = "v1";
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 100;

const modules = [
  { id: "img", ...img.meta },
  { id: "ipinfo", ...ipinfo.meta },
  { id: "weather", ...weather.meta },
];

// 限流为 isolate 级近似实现：Workers 免费版无共享状态后端
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const record = hits.get(ip);
  if (!record || now - record.start > RATE_LIMIT_WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    if (hits.size > 5000) hits.clear();
    return false;
  }
  record.count += 1;
  return record.count > RATE_LIMIT_MAX;
}

const app = new Hono();

app.use("*", async (c, next) => {
  const started = Date.now();
  await next();
  const rid = c.get("rid") || "-";
  console.log(
    `rid=${rid} method=${c.req.method} url=${c.req.url} status=${c.res.status} duration_ms=${Date.now() - started} ip=${getClientIp(c.req.raw)}`,
  );
});

app.use("*", cors({ origin: "*", allowMethods: ["GET", "HEAD", "OPTIONS"], maxAge: 86400 }));

app.use("/v1/*", async (c, next) => {
  const rid = crypto.randomUUID().slice(0, 12);
  c.set("rid", rid);
  c.header("X-Request-Id", rid);
  c.header("X-Powered-By", ""); // 去掉框架指纹

  const ip = getClientIp(c.req.raw);
  if (rateLimited(ip)) {
    return c.json({ error: "请求过于频繁，请稍后再试" }, 429);
  }
  await next();
});

app.get("/v1/meta", (c) =>
  c.json({ project: PROJECT_NAME, apiDir: API_DIR, modules }),
);

// 随机图片
app.get("/v1/img", (c) => img.handleRandom(c, "ua"));
app.get("/v1/img/", (c) => img.handleRandom(c, "ua"));
app.get("/v1/img/ua", (c) => img.handleRandom(c, "ua"));
app.get("/v1/img/h", (c) => img.handleRandom(c, "horizontal"));
app.get("/v1/img/v", (c) => img.handleRandom(c, "vertical"));
app.get("/v1/img/list", (c) => img.handleList(c, "ua"));
app.get("/v1/img/list/h", (c) => img.handleList(c, "horizontal"));
app.get("/v1/img/list/v", (c) => img.handleList(c, "vertical"));

// IP 信息
app.get("/v1/ipinfo", async (c) => {
  const queryIp = c.req.query("ip") || getClientIp(c.req.raw);
  return respondIp(c, queryIp);
});
app.get("/v1/ipinfo/", async (c) => respondIp(c, getClientIp(c.req.raw)));
app.get("/v1/ipinfo/:ip", async (c) => respondIp(c, c.req.param("ip")));

async function respondIp(c, ip) {
  try {
    const result = await ipinfo.queryIpInfoWithRetry(ip);
    return c.json(result);
  } catch (error) {
    const body = { error: String(error?.message || error) };
    if (error?.source) body.source = error.source;
    return c.json(body, Number(error?.statusCode) || 500);
  }
}

// 天气
app.get("/v1/weather", (c) => weather.handler(c, ""));
app.get("/v1/weather/", (c) => weather.handler(c, ""));
app.get("/v1/weather/realtime", (c) => weather.handler(c, "realtime"));
app.get("/v1/weather/week", (c) => weather.handler(c, "week"));

app.all("/v1/*", (c) => c.json({ error: "接口不存在" }, 404));

// 首页：动态读取 meta 渲染端点列表
app.get("/", async (c) => {
  const rows = modules
    .map(
      (m) => `
      <section>
        <h2>${m.name}</h2>
        <p class="desc">${m.description}</p>
        <table>
          <thead><tr><th>方法</th><th>路径</th><th>说明</th><th>参数</th></tr></thead>
          <tbody>
          ${m.endpoints
            .map(
              (e) =>
                `<tr><td>${e.method}</td><td><code>/v1/${m.id}${e.path === "/" ? "" : e.path === "" ? "" : e.path}</code></td><td>${e.description}</td><td><code>${e.params || ""}</code></td></tr>`,
            )
            .join("")}
          </tbody>
        </table>
      </section>`,
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${PROJECT_NAME}</title>
<link rel="icon" href="/favicon.ico">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 40px 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; line-height: 1.6; max-width: 900px; margin-inline: auto; }
  h1 { font-size: 28px; margin-bottom: 4px; }
  .tag { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #2563eb; color: #fff; vertical-align: middle; margin-left: 8px; }
  h2 { font-size: 18px; margin-bottom: 2px; }
  .desc { margin: 0 0 10px; opacity: .7; font-size: 14px; }
  section { margin-bottom: 32px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid rgba(128,128,128,.25); }
  th { font-weight: 600; opacity: .7; font-size: 13px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  footer { margin-top: 40px; font-size: 13px; opacity: .6; }
</style>
</head>
<body>
<h1>${PROJECT_NAME}<span class="tag">Cloudflare Workers</span></h1>
<p class="desc">Express 版同构移植：插件式模块、多上游容灾、边缘缓存</p>
${rows}
<footer>GET <code>/v1/meta</code> 获取全部端点 · 静态资源由 Workers Assets 提供</footer>
</body>
</html>`;

  return c.html(html);
});

export default app;
