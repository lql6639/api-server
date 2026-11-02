import imgConfig from "../../v1/img/config.json" with { type: "json" };
import { cacheGet, cacheSet, dedupe } from "../lib/cache.js";
import { fetchJson, fetchRaw, BROWSER_UA } from "../lib/http.js";

const CACHE_PREFIX = "img:";
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function normalizeBaseUrl(value) {
  return String(value ?? "").trim().replace(/\/+$/g, "");
}

function normalizePath(value) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  return s.startsWith("/") ? s : `/${s}`;
}

function normalizeOrientation(value) {
  const s = String(value ?? "").trim().toLowerCase();
  return s === "v" || s === "vertical" ? "vertical" : "horizontal";
}

function isVerticalByUserAgent(ua) {
  if (!ua) return false;
  return /(Mobile|Android|iPhone|iPad|iPod|HarmonyOS|Windows Phone)/i.test(ua);
}

function pickOrientation(c, mode) {
  if (mode !== "ua") return normalizeOrientation(mode);
  return isVerticalByUserAgent(c.req.header("user-agent")) ? "vertical" : "horizontal";
}

function extractList(data) {
  const preferred = [
    ["items"], ["list"], ["images"], ["result"], ["data"],
    ["data", "items"], ["data", "list"], ["data", "images"], ["data", "result"],
  ];
  const getByPath = (obj, keys) => {
    let cur = obj;
    for (const k of keys) {
      if (!cur || typeof cur !== "object") return undefined;
      cur = cur[k];
    }
    return cur;
  };
  const findArray = (node, depth) => {
    if (Array.isArray(node)) return node;
    if (!node || typeof node !== "object") return null;
    for (const p of preferred) {
      const v = getByPath(node, p);
      if (Array.isArray(v)) return v;
    }
    if (depth >= 3) return null;
    for (const v of Object.values(node)) {
      const r = findArray(v, depth + 1);
      if (Array.isArray(r)) return r;
    }
    return null;
  };
  return findArray(data, 0) || [];
}

function normalizeCached(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!Array.isArray(value.items) || !Number.isFinite(Number(value.fetchedAt)))
    return null;
  const baseUrl = normalizeBaseUrl(imgConfig.url);
  if (!baseUrl) return null;
  const items = value.items.reduce((acc, item) => {
    if (!item || typeof item !== "object") return acc;
    const p = normalizePath(item.path);
    if (!p) return acc;
    acc.push({ name: String(item.name ?? "").trim(), path: p });
    return acc;
  }, []);
  return {
    items,
    urls: items.map((it) => `${baseUrl}${it.path}`),
    fetchedAt: Number(value.fetchedAt),
    baseUrl,
  };
}

const ttlSeconds = Number(imgConfig.cache_ttl) > 0 ? Number(imgConfig.cache_ttl) : 0;

function isFresh(data) {
  if (ttlSeconds <= 0) return false;
  return Date.now() - data.fetchedAt < ttlSeconds * 1000;
}

async function refresh(orientation) {
  const o = normalizeOrientation(orientation);
  const key = CACHE_PREFIX + o;

  return dedupe(key, async () => {
    const baseUrl = normalizeBaseUrl(imgConfig.url);
    if (!baseUrl) throw Object.assign(new Error("配置缺少url"), { statusCode: 500 });

    const upstreamUrl = String(imgConfig?.upstream?.[o] || "").trim();
    if (!upstreamUrl) throw Object.assign(new Error("配置缺少upstream"), { statusCode: 500 });

    const raw = await fetchJson(upstreamUrl, {
      timeout: Number(imgConfig.timeout_ms) || 10000,
      headers: imgConfig?.upstream_headers || {},
    });

    const items = [];
    const urls = [];
    for (const it of extractList(raw)) {
      if (!it || typeof it !== "object") continue;
      const p = normalizePath(it.path);
      if (!p) continue;
      items.push({ name: String(it.name ?? "").trim(), path: p });
      urls.push(`${baseUrl}${p}`);
    }

    const data = { items, urls, fetchedAt: Date.now(), baseUrl };
    await cacheSet(key, data, ttlSeconds > 0 ? ttlSeconds * 2 : 0);
    return data;
  });
}

async function getList(orientation) {
  const key = CACHE_PREFIX + orientation;
  const cached = normalizeCached(await cacheGet(key));
  if (cached && isFresh(cached)) return cached;
  if (cached && cached.items.length > 0) {
    refresh(orientation).catch(() => {});
    return cached;
  }
  return refresh(orientation);
}

function errorJson(message, status = 502) {
  return Response.json({ status: "error", time: Date.now(), message }, { status });
}

function noStore(response) {
  const cacheControl =
    "no-store, no-cache, max-age=0, must-revalidate, proxy-revalidate";
  try {
    response.headers.set("Cache-Control", cacheControl);
    return response;
  } catch {
    // Response.redirect() 等构造出的 headers 是 immutable，需重建响应
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", cacheControl);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

async function proxyImage(imageUrl) {
  const maxBytes =
    Number(imgConfig.max_image_bytes) > 0
      ? Number(imgConfig.max_image_bytes)
      : DEFAULT_MAX_IMAGE_BYTES;

  const upstream = await fetchRaw(imageUrl, {
    timeout: Number(imgConfig.timeout_ms) || 10000,
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    },
  });

  if (!upstream.ok) throw new Error("图片上游响应异常");

  const contentType = String(upstream.headers.get("content-type") || "").trim();
  const mime = contentType.split(";")[0].toLowerCase();
  if (!mime.startsWith("image/") || mime === "image/svg+xml") {
    throw new Error("图片上游返回了非图片内容");
  }
  const len = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(len) && len > maxBytes) {
    throw new Error("图片大小超过限制");
  }

  const headers = new Headers({
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
  if (Number.isFinite(len) && len >= 0) headers.set("Content-Length", String(len));
  const etag = upstream.headers.get("etag");
  if (etag) headers.set("ETag", etag);

  return new Response(upstream.body, { status: upstream.status, headers });
}

function isDirectMode() {
  return String(imgConfig.mode ?? "").trim().toLowerCase() === "direct";
}

function buildDirectList(orientation) {
  const o = normalizeOrientation(orientation);
  const raw = imgConfig?.upstream?.[o];
  const candidates = (Array.isArray(raw) ? raw : [raw])
    .map((v) => String(v ?? "").trim())
    .filter(Boolean);
  if (candidates.length === 0) return null;
  const items = candidates.map((u) => {
    let path = "";
    try {
      path = new URL(u).pathname || "";
    } catch {
      path = "";
    }
    return { name: path.replace(/^\/+/, ""), path };
  });
  return {
    items,
    urls: candidates,
    fetchedAt: Date.now(),
    baseUrl: "",
  };
}

async function loadListOrStale(orientation) {
  if (isDirectMode()) {
    const direct = buildDirectList(orientation);
    if (!direct)
      throw Object.assign(new Error("配置缺少upstream"), { statusCode: 500 });
    return direct;
  }
  try {
    return await getList(orientation);
  } catch (e) {
    const stale = normalizeCached(await cacheGet(CACHE_PREFIX + orientation));
    if (stale && stale.items.length > 0) return stale;
    throw e;
  }
}

export async function handleRandom(c, mode) {
  const type = String(c.req.query("type") || "302").trim().toLowerCase();
  const orientation = pickOrientation(c, mode);

  let list;
  try {
    list = await loadListOrStale(orientation);
  } catch (e) {
    return noStore(errorJson(String(e?.message || e), Number(e?.statusCode) || 502));
  }

  if (!list || list.urls.length === 0) {
    return noStore(errorJson("未获取到图片列表"));
  }

  // 直出模式按主备顺序取第一个（失败再切下一个）；列表模式随机取
  const idx = isDirectMode()
    ? 0
    : Math.floor(Math.random() * list.urls.length);
  const fullUrl = list.urls[idx];
  const it = list.items[idx] || { name: "", path: "" };
  const data = {
    id: String(idx + 1),
    name: it.name,
    url: list.baseUrl || fullUrl,
    path: it.path,
    fullUrl,
  };

  if (type === "302") {
    return noStore(Response.redirect(fullUrl, 302));
  }

  if (type === "text") {
    return noStore(
      new Response(fullUrl, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );
  }

  if (type === "json") {
    return noStore(Response.json({ status: "success", time: Date.now(), data }));
  }

  if (type === "img") {
    const total = list.urls.length;
    let lastError = null;
    for (let i = 0; i < total; i++) {
      try {
        return noStore(await proxyImage(list.urls[(idx + i) % total]));
      } catch (e) {
        lastError = e;
      }
    }
    return noStore(errorJson(String(lastError?.message || "图片上游不可用")));
  }

  return noStore(errorJson("type仅支持text/json/302/img", 400));
}

export async function handleList(c, mode) {
  const type = String(c.req.query("type") || "json").trim().toLowerCase();
  const orientation = pickOrientation(c, mode);

  if (isDirectMode()) {
    return noStore(
      errorJson(
        "当前为直出模式(direct)，不支持列表，请使用 /v1/img?type=302|json|text|img",
        400,
      ),
    );
  }

  let list;
  try {
    list = await loadListOrStale(orientation);
  } catch (e) {
    return noStore(errorJson(String(e?.message || e), Number(e?.statusCode) || 502));
  }

  if (!list || list.urls.length === 0) {
    return noStore(errorJson("未获取到图片列表"));
  }

  if (type === "text") {
    return noStore(
      new Response(list.urls.join("\n"), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );
  }
  if (type === "json") {
    const data = list.items.map((it, idx) => ({
      id: String(idx + 1),
      name: it.name,
      url: list.baseUrl,
      path: it.path,
    }));
    return noStore(
      Response.json({ status: "success", total: data.length, time: Date.now(), data }),
    );
  }
  return noStore(errorJson("type仅支持text/json", 400));
}

export const meta = {
  name: "随机图片",
  description: "上游聚合，UA 自适应",
  endpoints: [
    { method: "GET", path: "/", description: "UA 自适应", params: "type=302|json|text|img" },
    { method: "GET", path: "/h", description: "横屏", params: "type=302|json|text|img" },
    { method: "GET", path: "/v", description: "竖屏", params: "type=302|json|text|img" },
    { method: "GET", path: "/list", description: "图片列表", params: "type=json|text" },
    { method: "GET", path: "/list/h", description: "横屏列表", params: "type=json|text" },
    { method: "GET", path: "/list/v", description: "竖屏列表", params: "type=json|text" },
  ],
};
