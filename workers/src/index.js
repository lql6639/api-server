import { Hono } from "hono";
import { cors } from "hono/cors";
import indexTemplate from "../../template/index.html";
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

// 首页：复用 Node 版模板 template/index.html（Text 模块导入），运行时替换占位符
function renderIndex() {
  const vars = {
    projectName: PROJECT_NAME,
    maxRequests: String(RATE_LIMIT_MAX),
    timeWindow: String(Math.round(RATE_LIMIT_WINDOW_MS / 1000)),
    year: String(new Date().getFullYear()),
    apiDir: API_DIR,
  };
  let html = indexTemplate.replace(/^\uFEFF/, "");
  for (const [key, value] of Object.entries(vars)) {
    html = html.split("${" + key + "}").join(value);
  }
  return html;
}

app.get("/", (c) => c.html(renderIndex()));

export default app;
