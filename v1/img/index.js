const express = require("express");
const crypto = require("crypto");
const path = require("path");
const HttpClient = require("../../utils/httpClient");
const logger = require("../../utils/logger");
const { getStore } = require("../../libs/cacheStore");

const router = express.Router();
const config = require(path.join(__dirname, "config.json"));

const http = new HttpClient({ timeout: Number(config?.timeout_ms) || 10000 });

const cache = getStore();
const CACHE_PREFIX = "img:";
const LOCK_PREFIX = "img:lock:";
const LOCK_TTL = 30;
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const inflights = { horizontal: null, vertical: null };

router.use((req, res, next) => {
  res.set(
    "Cache-Control",
    "no-store, no-cache, max-age=0, must-revalidate, proxy-revalidate",
  );
  next();
});

function normalizeBaseUrl(value) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  return s.replace(/\/+$/g, "");
}

function normalizePath(value) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  return s.startsWith("/") ? s : `/${s}`;
}

function normalizeOrientation(value) {
  const s = String(value ?? "")
    .trim()
    .toLowerCase();
  if (s === "v" || s === "vertical") return "vertical";
  return "horizontal";
}

function isVerticalByUserAgent(ua) {
  const s = String(ua ?? "");
  if (!s) return false;
  return /(Mobile|Android|iPhone|iPad|iPod|HarmonyOS|Windows Phone)/i.test(s);
}

function pickOrientationByReq(req) {
  const ua = req?.headers?.["user-agent"];
  return isVerticalByUserAgent(ua) ? "vertical" : "horizontal";
}

function cacheKey(orientation) {
  return CACHE_PREFIX + normalizeOrientation(orientation);
}

function lockKey(orientation) {
  return LOCK_PREFIX + normalizeOrientation(orientation);
}

function extractList(data) {
  function getByPath(obj, keys) {
    let cur = obj;
    for (const k of keys) {
      if (!cur || typeof cur !== "object") return undefined;
      cur = cur[k];
    }
    return cur;
  }

  function findArray(node, depth) {
    if (Array.isArray(node)) return node;
    if (!node || typeof node !== "object") return null;

    const preferredPaths = [
      ["items"],
      ["list"],
      ["images"],
      ["result"],
      ["data"],
      ["data", "items"],
      ["data", "list"],
      ["data", "images"],
      ["data", "result"],
    ];
    for (const p of preferredPaths) {
      const v = getByPath(node, p);
      if (Array.isArray(v)) return v;
    }

    if (depth >= 3) return null;
    for (const v of Object.values(node)) {
      const r = findArray(v, depth + 1);
      if (Array.isArray(r)) return r;
    }
    return null;
  }

  return findArray(data, 0) || [];
}

function ttlMs() {
  const v = Number(config?.cache_ttl);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v * 1000;
}

function ttlSec() {
  const v = Number(config?.cache_ttl);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v;
}

function isCacheFresh(data, now, ttl) {
  if (ttl <= 0) return false;
  if (!data || data.items.length === 0) return false;
  return now - (data.fetchedAt || 0) < ttl;
}

function getUpstreamUrl(orientation) {
  const o = normalizeOrientation(orientation);
  const upstream =
    config?.upstream && typeof config.upstream === "object"
      ? config.upstream
      : null;
  return upstream ? String(upstream[o] || "").trim() : "";
}

function getUpstreamHeaders(orientation) {
  const o = normalizeOrientation(orientation);
  const base =
    config?.upstream_headers && typeof config.upstream_headers === "object"
      ? config.upstream_headers
      : null;
  const h =
    o === "vertical"
      ? config?.upstream_headers_vertical &&
        typeof config.upstream_headers_vertical === "object"
        ? config.upstream_headers_vertical
        : null
      : config?.upstream_headers_horizontal &&
          typeof config.upstream_headers_horizontal === "object"
        ? config.upstream_headers_horizontal
        : null;
  return { ...(base || {}), ...(h || {}) };
}

function normalizeCachedData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!Array.isArray(value.items) || !Number.isFinite(Number(value.fetchedAt)))
    return null;

  const baseUrl = normalizeBaseUrl(config?.url);
  if (!baseUrl) return null;
  const items = value.items.reduce((result, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return result;
    const itemPath = normalizePath(item.path);
    if (!itemPath) return result;
    result.push({ name: String(item.name ?? "").trim(), path: itemPath });
    return result;
  }, []);
  return {
    items,
    urls: items.map((item) => `${baseUrl}${item.path}`),
    fetchedAt: Number(value.fetchedAt),
    baseUrl,
  };
}

async function startRefresh(orientation) {
  const o = normalizeOrientation(orientation);

  if (inflights[o]) return inflights[o];

  const key = cacheKey(o);
  const lok = lockKey(o);
  const ttl = ttlSec();

  inflights[o] = (async () => {
    const lockToken = crypto.randomUUID();
    let locked = false;
    try {
      locked = await cache.setNX(lok, lockToken, LOCK_TTL);
      if (!locked) {
        const deadline = Date.now() + LOCK_TTL * 1000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
          const cachedData = normalizeCachedData(await cache.get(key));
          if (cachedData) return cachedData;
        }
        locked = await cache.setNX(lok, lockToken, LOCK_TTL);
        if (!locked) {
          const err = new Error("图片列表正在刷新");
          err.statusCode = 503;
          throw err;
        }
      }

      logger.debug(`刷新图片列表: ${o}`);

      const baseUrl = normalizeBaseUrl(config?.url);
      if (!baseUrl) {
        const err = new Error("配置缺少url");
        err.statusCode = 500;
        throw err;
      }

      const upstreamUrl = getUpstreamUrl(o);
      if (!upstreamUrl) {
        const err = new Error("配置缺少upstream");
        err.statusCode = 500;
        throw err;
      }

      const headers = getUpstreamHeaders(o);
      const raw = await http.get(upstreamUrl, {}, { headers });
      const list = extractList(raw);

      const items = [];
      const urls = [];
      for (const it of list) {
        if (!it || typeof it !== "object") continue;
        const p = normalizePath(it.path);
        if (!p) continue;
        const name = String(it.name ?? "").trim();
        items.push({ name, path: p });
        urls.push(`${baseUrl}${p}`);
      }

      const data = {
        items,
        urls,
        fetchedAt: Date.now(),
        baseUrl,
      };

      const storeTTL = ttl > 0 ? ttl * 2 : 0;
      await cache.set(key, data, storeTTL);
      return data;
    } catch (e) {
      logger.warn(`刷新图片列表失败: ${o}`, { error: e.message });
      throw e;
    } finally {
      if (locked) {
        try {
          await cache.delIfValue(lok, lockToken);
        } catch (error) {
          logger.warn("图片刷新锁释放失败", { error: error.message });
        }
      }
      inflights[o] = null;
    }
  })();

  return inflights[o];
}

async function getCacheNonBlocking(orientation) {
  const o = normalizeOrientation(orientation);
  const key = cacheKey(o);
  const now = Date.now();
  const ttl = ttlMs();

  const data = normalizeCachedData(await cache.get(key));
  if (data && isCacheFresh(data, now, ttl)) return data;

  if (data && data.items.length > 0) {
    startRefresh(o).catch(() => {});
    return data;
  }

  return startRefresh(o);
}

function warmUp() {
  startRefresh("horizontal")
    .then(() => logger.info("图片预热完成: horizontal"))
    .catch(() => {});
  startRefresh("vertical")
    .then(() => logger.info("图片预热完成: vertical"))
    .catch(() => {});
}

warmUp();

function getType(value, defaultValue) {
  const s = String(value ?? "")
    .trim()
    .toLowerCase();
  return s || defaultValue;
}

function buildListResponseData(c) {
  return c.items.map((it, idx) => ({
    id: String(idx + 1),
    name: it.name,
    url: c.baseUrl,
    path: it.path,
  }));
}

async function sendRandom(req, res, mode) {
  const type = getType(req.query.type, "302");
  const orientation =
    mode === "ua" ? pickOrientationByReq(req) : normalizeOrientation(mode);

  let c = null;
  try {
    c = await getCacheNonBlocking(orientation);
  } catch (e) {
    const key = cacheKey(normalizeOrientation(orientation));
    let stale = null;
    try {
      stale = normalizeCachedData(await cache.get(key));
    } catch {
      stale = null;
    }
    if (stale && stale.items.length > 0) c = stale;
    else {
      const code = Number(e?.statusCode) || 502;
      return res
        .status(code)
        .json({
          status: "error",
          time: Date.now(),
          message: String(e?.message || e),
        });
    }
  }

  if (!c || c.urls.length === 0) {
    return res
      .status(502)
      .json({ status: "error", time: Date.now(), message: "未获取到图片列表" });
  }

  const idx = Math.floor(Math.random() * c.urls.length);
  const fullUrl = c.urls[idx];
  const it = c.items[idx] || { name: "", path: "" };
  const data = {
    id: String(idx + 1),
    name: it.name,
    url: c.baseUrl,
    path: it.path,
    fullUrl,
  };

  if (type === "302") {
    return res.redirect(302, fullUrl);
  }
  if (type === "img") {
    try {
      const timeout = Number(config?.timeout_ms) || 10000;
      const configuredMax = Number(config?.max_image_bytes);
      const maxImageBytes =
        configuredMax > 0 ? configuredMax : DEFAULT_MAX_IMAGE_BYTES;
      const r = await http.axios.get(fullUrl, {
        responseType: "stream",
        timeout,
        maxContentLength: maxImageBytes,
        maxBodyLength: maxImageBytes,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
        validateStatus: () => true,
      });

      if (!r || !r.data) {
        return res
          .status(502)
          .json({ status: "error", time: Date.now(), message: "图片响应为空" });
      }

      const status = Number(r.status) || 502;
      const contentType = String(r.headers?.["content-type"] || "").trim();
      const mimeType = contentType.split(";", 1)[0].toLowerCase();
      const contentLength = Number(r.headers?.["content-length"]);
      if (status < 200 || status >= 300) {
        r.data.destroy();
        return res
          .status(502)
          .json({
            status: "error",
            time: Date.now(),
            message: "图片上游响应异常",
          });
      }
      if (!mimeType.startsWith("image/") || mimeType === "image/svg+xml") {
        r.data.destroy();
        return res
          .status(502)
          .json({
            status: "error",
            time: Date.now(),
            message: "图片上游返回了非图片内容",
          });
      }
      if (Number.isFinite(contentLength) && contentLength > maxImageBytes) {
        r.data.destroy();
        return res
          .status(502)
          .json({
            status: "error",
            time: Date.now(),
            message: "图片大小超过限制",
          });
      }

      res.status(status);
      res.set("Content-Type", contentType);
      res.set("X-Content-Type-Options", "nosniff");
      if (Number.isFinite(contentLength) && contentLength >= 0) {
        res.set("Content-Length", String(contentLength));
      }
      if (r.headers && r.headers["etag"])
        res.set("ETag", String(r.headers["etag"]));

      let transferredBytes = 0;
      r.data.on("data", (chunk) => {
        transferredBytes += chunk.length;
        if (transferredBytes > maxImageBytes) {
          r.data.destroy(new Error("图片大小超过限制"));
        }
      });
      r.data.on("error", (e) => {
        logger.error(`流式传输错误: ${e?.message || e}`);
        if (!res.headersSent) res.status(502).end("图片传输失败");
        else res.end();
      });
      if (typeof res.once === "function") {
        res.once("close", () => {
          if (!res.writableEnded && !r.data.destroyed) {
            r.data.destroy();
          }
        });
      }

      r.data.pipe(res);
      return;
    } catch (e) {
      return res
        .status(502)
        .json({
          status: "error",
          time: Date.now(),
          message: String(e?.message || e),
        });
    }
  }
  if (type === "text") {
    res.type("text/plain; charset=utf-8");
    return res.send(fullUrl);
  }
  if (type === "json") {
    return res.json({ status: "success", time: Date.now(), data });
  }

  return res
    .status(400)
    .json({
      status: "error",
      time: Date.now(),
      message: "type仅支持text/json/302/img",
    });
}

async function sendList(req, res, mode) {
  const type = getType(req.query.type, "json");
  const orientation =
    mode === "ua" ? pickOrientationByReq(req) : normalizeOrientation(mode);

  let c = null;
  try {
    c = await getCacheNonBlocking(orientation);
  } catch (e) {
    const key = cacheKey(normalizeOrientation(orientation));
    let stale = null;
    try {
      stale = normalizeCachedData(await cache.get(key));
    } catch {
      stale = null;
    }
    if (stale && stale.items.length > 0) c = stale;
    else {
      const code = Number(e?.statusCode) || 502;
      return res
        .status(code)
        .json({
          status: "error",
          time: Date.now(),
          message: String(e?.message || e),
        });
    }
  }

  if (!c || c.urls.length === 0) {
    return res
      .status(502)
      .json({ status: "error", time: Date.now(), message: "未获取到图片列表" });
  }

  if (type === "text") {
    res.type("text/plain; charset=utf-8");
    return res.send(c.urls.join("\n"));
  }
  if (type === "json") {
    const data = buildListResponseData(c);
    return res.json({
      status: "success",
      total: data.length,
      time: Date.now(),
      data,
    });
  }

  return res
    .status(400)
    .json({
      status: "error",
      time: Date.now(),
      message: "type仅支持text/json",
    });
}

router.get("/", (req, res) => sendRandom(req, res, "ua"));
router.get("/ua", (req, res) => sendRandom(req, res, "ua"));
router.get("/h", (req, res) => sendRandom(req, res, "horizontal"));
router.get("/v", (req, res) => sendRandom(req, res, "vertical"));

router.get("/list", (req, res) => sendList(req, res, "ua"));
router.get("/list/h", (req, res) => sendList(req, res, "horizontal"));
router.get("/list/v", (req, res) => sendList(req, res, "vertical"));

module.exports = router;
module.exports.meta = {
  name: "随机图片",
  description: "上游聚合，UA 自适应",
  endpoints: [
    {
      method: "GET",
      path: "/",
      description: "UA 自适应",
      params: "type=302|json|text|img",
    },
    {
      method: "GET",
      path: "/h",
      description: "横屏",
      params: "type=302|json|text|img",
    },
    {
      method: "GET",
      path: "/v",
      description: "竖屏",
      params: "type=302|json|text|img",
    },
    {
      method: "GET",
      path: "/list",
      description: "图片列表",
      params: "type=json|text",
    },
    {
      method: "GET",
      path: "/list/h",
      description: "横屏列表",
      params: "type=json|text",
    },
    {
      method: "GET",
      path: "/list/v",
      description: "竖屏列表",
      params: "type=json|text",
    },
  ],
};
