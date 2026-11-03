import { Hono } from "hono";
import { cors } from "hono/cors";
import { marked } from "marked";
import indexTemplate from "../template/index.html";
import markdownTemplate from "../template/markdown.html";
import docReadme from "../public/docs/README.md";
import docImg from "../public/docs/img.md";
import docIpinfo from "../public/docs/ipinfo.md";
import docWeather from "../public/docs/weather.md";
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

const docs = {
  "README.md": docReadme,
  "img.md": docImg,
  "ipinfo.md": docIpinfo,
  "weather.md": docWeather,
};

// 与旧版 utils/markdownRenderer.js 一致的消毒逻辑
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function sanitizeUrl(value, allowDataImages = false) {
  const url = String(value || "").trim();
  if (!url) return "";
  const compact = url
    .replace(/[\u0000-\u0020\u007f-\u009f]/g, "")
    .toLowerCase();
  const firstDelimiter = compact.search(/[/?#]/);
  const prefix =
    firstDelimiter === -1 ? compact : compact.slice(0, firstDelimiter);
  if (prefix.includes("&") || prefix.includes("\\")) return "";
  const schemeMatch = compact.match(/^([a-z][a-z0-9+.-]*):/);
  if (!schemeMatch) return url;
  const scheme = schemeMatch[1];
  if (allowDataImages && scheme === "data") {
    return /^data:image\/(?:avif|gif|jpeg|png|webp);base64,/i.test(url)
      ? url
      : "";
  }
  const allowedSchemes = allowDataImages
    ? new Set(["http", "https"])
    : new Set(["http", "https", "mailto", "tel"]);
  if (!allowedSchemes.has(scheme)) return "";
  return url;
}

const mdRenderer = new marked.Renderer();
// marked@12 的 Renderer 仍为旧签名 link(href, title, text)，text 已是内联解析后的 HTML
mdRenderer.html = (html) => escapeHtml(html);
mdRenderer.link = (href, title, text) => {
  const safeHref = sanitizeUrl(href);
  if (!safeHref) return text;
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<a href="${escapeHtml(safeHref)}"${titleAttr}>${text}</a>`;
};
mdRenderer.image = (href, title, text) => {
  const safeHref = sanitizeUrl(href, true);
  if (!safeHref) return escapeHtml(text);
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text)}"${titleAttr}>`;
};
marked.use({ renderer: mdRenderer });

function renderMarkdown(fileName, markdownContent) {
  const htmlContent = marked.parse(markdownContent);
  const result = markdownTemplate
    .replace(/\$\{projectName\}/g, PROJECT_NAME)
    .replace(/\$\{title\}/g, fileName)
    .replace(/\$\{htmlContent\}/g, htmlContent)
    .replace(/\$\{year\}/g, String(new Date().getFullYear()));
  return result;
}

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

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "HEAD", "OPTIONS"],
    maxAge: 86400,
  }),
);

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
    // ?nocache=1（或 ?refresh=1）跳过读缓存，用于调整上游后立即验证
    const q = c.req.query();
    const fresh = q.nocache === "1" || q.refresh === "1";
    const result = await ipinfo.queryIpInfoWithRetry(ip, { fresh });
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

// 文档：/docs/*.md 渲染为 HTML，/docs/*.raw.md 直出原始 markdown
app.get("/docs/:file", (c) => {
  const file = c.req.param("file");
  // no-transform：阻止 Cloudflare 边缘向 HTML 注入 beacon / challenge 脚本
  c.header("Cache-Control", "no-transform");
  if (file.endsWith(".raw.md")) {
    const name = file.slice(0, -7) + ".md";
    if (!(name in docs)) return c.json({ error: "文档不存在" }, 404);
    return c.body(docs[name], 200, {
      "Content-Type": "text/markdown; charset=utf-8",
    });
  }
  if (!file.endsWith(".md") || !(file in docs)) {
    return c.json({ error: "文档不存在" }, 404);
  }
  return c.html(renderMarkdown(file, docs[file]));
});

app.get("/", (c) => {
  // no-transform：阻止 Cloudflare 边缘向 HTML 注入 beacon / challenge 脚本
  c.header("Cache-Control", "no-transform");
  return c.html(renderIndex());
});

export default app;
