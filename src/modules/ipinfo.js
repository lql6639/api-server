import ipinfoConfig from "../../v1/ipinfo/config.json" with { type: "json" };
import { cacheGet, cacheSet, dedupe } from "../lib/cache.js";
import { fetchJson } from "../lib/http.js";
import {
  isIP,
  isIpv4MappedIpv6,
  ipv4Prefix24,
  ipv6Prefix48,
} from "../lib/ip.js";

const CACHE_PREFIX = "ipinfo:";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const IP_VERSION_VALUES = new Map([
  ["ipv4", 4],
  ["ipv6", 6],
]);

const { upstream_apis: upstreamApis, response_fields: responseFields } =
  ipinfoConfig;
const cacheTtl = Number(ipinfoConfig.cache_ttl) || 0;
const retryCount = Number(ipinfoConfig.retry_count) || 0;
const queryTimeout = Number(ipinfoConfig.default_timeout) || 1000;

const apiIpVersions = new Map();
const apiRequestCounters = new Map();
let lastUsedApiIndex = -1;

upstreamApis.forEach((api) => {
  apiIpVersions.set(api.name, parseIpVersions(api));
  apiRequestCounters.set(api.name, {
    count: 0,
    windowStartTime: Date.now(),
  });
});

function parseIpVersions(api) {
  if (api.ip_versions === undefined) {
    return new Set(IP_VERSION_VALUES.values());
  }
  const versions = String(api.ip_versions)
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter((v) => IP_VERSION_VALUES.has(v));
  return new Set(versions.map((v) => IP_VERSION_VALUES.get(v)));
}

function supportsIpVersion(name, version) {
  return apiIpVersions.get(name)?.has(version) === true;
}

function isApiAvailable(api) {
  if (!api?.enabled) return false;
  const counter = apiRequestCounters.get(api.name);
  if (!counter) return false;
  const now = Date.now();
  if (now - counter.windowStartTime > Number(api.time_window || 60) * 1000) {
    counter.count = 0;
    counter.windowStartTime = now;
  }
  return counter.count < Number(api.max_requests || 60);
}

function getAvailableApis(ipVersion) {
  return upstreamApis.filter(
    (api) => supportsIpVersion(api.name, ipVersion) && isApiAvailable(api),
  );
}

function selectNextApi(available) {
  if (!available || available.length === 0) return null;
  if (available.length === 1) return available[0];
  const strategy = ipinfoConfig.load_balance_strategy || "round_robin";
  if (strategy === "random") {
    return available[Math.floor(Math.random() * available.length)];
  }
  if (strategy === "least_used") {
    return available.reduce((least, current) => {
      const leastCount = apiRequestCounters.get(least.name)?.count ?? 0;
      const currentCount = apiRequestCounters.get(current.name)?.count ?? 0;
      return currentCount < leastCount ? current : least;
    });
  }
  lastUsedApiIndex = (lastUsedApiIndex + 1) % available.length;
  return available[lastUsedApiIndex];
}

function getNestedValue(obj, path) {
  if (!path) return undefined;
  if (path.includes(",")) {
    return path
      .split(",")
      .map((field) => getNestedValue(obj, field.trim()))
      .filter((v) => v)
      .join("");
  }
  return path.split(".").reduce((cur, key) => {
    if (cur === null || cur === undefined || typeof cur !== "object")
      return undefined;
    return cur[key];
  }, obj);
}

function applyFieldTemplate(value, variables) {
  let out = String(value ?? "");
  if (!variables) return out;
  for (const [k, v] of Object.entries(variables)) {
    out = out.split(`{${k}}`).join(v === undefined || v === null ? "" : String(v));
  }
  return out;
}

function resolveFieldValue(data, apiField, variables) {
  if (apiField === undefined || apiField === null) return undefined;
  const raw = String(apiField);
  if (raw.includes(",")) {
    return raw
      .split(",")
      .map((field) => resolveFieldValue(data, field.trim(), variables))
      .filter((v) => v)
      .join("");
  }
  const directMatch = raw.match(/^\{([\w.-]+)\}$/);
  if (directMatch && Object.prototype.hasOwnProperty.call(variables || {}, directMatch[1])) {
    return variables[directMatch[1]];
  }
  if (raw.includes("{") && raw.includes("}")) {
    const parts = raw.split(".").map((part) => {
      const m = part.match(/^\{([\w.-]+)\}$/);
      if (!m) return part;
      if (!Object.prototype.hasOwnProperty.call(variables || {}, m[1]))
        return undefined;
      return variables[m[1]];
    });
    if (!parts.some((p) => p === undefined)) {
      let cur = data;
      for (const p of parts) {
        if (cur === null || cur === undefined || typeof cur !== "object")
          return undefined;
        cur = cur[p];
      }
      if (cur !== undefined) return cur;
    }
  }
  return getNestedValue(data, applyFieldTemplate(raw, variables));
}

function mapResponse(data, fieldMapping, variables) {
  const result = {};
  for (const [standardField, apiField] of Object.entries(fieldMapping || {})) {
    result[standardField] = resolveFieldValue(data, apiField, variables);
  }
  return result;
}

function getCacheKey(ip) {
  const ipStr = String(ip || "").trim();
  if (isIP(ipStr) === 4) return ipv4Prefix24(ipStr);
  if (isIP(ipStr) === 6) return ipv6Prefix48(ipStr.split("%")[0]);
  return ipStr;
}

function sanitizeCached(cached, ip) {
  if (
    !cached ||
    typeof cached !== "object" ||
    Array.isArray(cached) ||
    typeof cached.source !== "string" ||
    !cached.source.trim() ||
    !cached.data ||
    typeof cached.data !== "object" ||
    Array.isArray(cached.data)
  )
    return null;

  const data = {};
  for (const field of responseFields) {
    if (["__proto__", "constructor", "prototype"].includes(field)) continue;
    const value = cached.data[field];
    if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
      data[field] = value;
    }
  }
  if (responseFields.includes("ip")) data.ip = ip;
  return { source: cached.source.trim(), data };
}

export function parseIp(ip) {
  const input = String(ip || "").trim();
  const normalizedIp = input.includes(":") ? input.split("%")[0] : input;
  const ipVersion = isIP(normalizedIp);
  if (ipVersion === 0) {
    const error = new Error("无效的IP地址");
    error.statusCode = 400;
    throw error;
  }
  if (isIpv4MappedIpv6(normalizedIp)) {
    const error = new Error("不支持IPv4映射IPv6地址");
    error.statusCode = 400;
    throw error;
  }
  return { normalizedIp, ipVersion };
}

async function queryProvider(ip, api) {
  const counter = apiRequestCounters.get(api.name);
  if (counter) counter.count += 1;
  const url = String(api.url).split("{ip}").join(encodeURIComponent(ip));
  try {
    const raw = await fetchJson(url, {
      timeout: queryTimeout,
      maxBytes: MAX_RESPONSE_BYTES,
      headers: { "User-Agent": "api-server-workers/1.0" },
    });
    const mapped = mapResponse(raw, api.field_mapping, { ip });
    const data = {};
    for (const field of responseFields) {
      if (mapped[field] !== undefined) data[field] = mapped[field];
    }
    return { source: api.name, data };
  } catch (error) {
    const err = new Error(`查询失败: ${error.message}`);
    err.source = api.name;
    throw err;
  }
}

async function queryProviders(ip, ipVersion) {
  let lastError = null;
  let tried = new Set();

  for (let round = 0; round <= retryCount; round++) {
    let available = getAvailableApis(ipVersion).filter((a) => !tried.has(a.name));
    if (available.length === 0) {
      if (round < retryCount) {
        tried = new Set();
        available = getAvailableApis(ipVersion);
        if (available.length === 0) break;
      } else {
        break;
      }
    }
    const api = selectNextApi(available);
    if (!api) break;
    try {
      const result = await queryProvider(ip, api);
      return result;
    } catch (error) {
      lastError = error;
      tried.add(api.name);
    }
  }

  if (lastError) throw lastError;
  const err = new Error(`没有支持 IPv${ipVersion} 的可用API`);
  err.source = "系统";
  err.statusCode = 503;
  throw err;
}

export async function queryIpInfoWithRetry(ip) {
  const { normalizedIp, ipVersion } = parseIp(ip);
  const cacheKey = CACHE_PREFIX + getCacheKey(normalizedIp);

  const cached = sanitizeCached(await cacheGet(cacheKey), normalizedIp);
  if (cached) return cached;

  return dedupe(cacheKey, async () => {
    const again = sanitizeCached(await cacheGet(cacheKey), normalizedIp);
    if (again) return again;

    const result = await queryProviders(normalizedIp, ipVersion);
    await cacheSet(cacheKey, result, cacheTtl);
    return result;
  });
}

export const meta = {
  name: "IP 信息",
  description: "多上游容灾，自动重试",
  endpoints: [
    { method: "GET", path: "/", description: "查询 当前/指定 IP", params: "?ip=x.x.x.x" },
    { method: "GET", path: "/:ip", description: "查询指定 IP", params: "路径参数" },
  ],
};
