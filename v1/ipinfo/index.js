const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const net = require("net");
const path = require("path");
const logger = require("../../utils/logger");
const { getStore } = require("../../libs/cacheStore");

const router = express.Router();
const configPath = path.join(__dirname, "config.json");
const config = require(configPath);

const cache = getStore();
const CACHE_PREFIX = "ipinfo:";
const LOCK_PREFIX = "ipinfo:lock:";
const LOCK_TTL = 15;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const IP_VERSION_VALUES = new Map([
  ["ipv4", 4],
  ["ipv6", 6],
]);
let lastUsedApiIndex = -1;
const apiRequestCounters = Object.create(null);
const apiIpVersions = new Map();
const apiNames = new Set();
const inflightQueries = new Map();
if (!Array.isArray(config.upstream_apis)) {
  throw new Error("upstream_apis 必须是数组");
}
if (!Array.isArray(config.response_fields)) {
  throw new Error("response_fields 必须是数组");
}
const cacheTtl = Number(config.cache_ttl);
if (!Number.isFinite(cacheTtl) || cacheTtl < 0) {
  throw new Error("cache_ttl 必须是非负数");
}
config.upstream_apis.forEach((api) => {
  if (!api || typeof api.name !== "string" || !api.name.trim()) {
    throw new Error("每个 upstream API 必须配置非空 name");
  }
  const apiName = api.name.trim();
  if (apiNames.has(apiName)) {
    throw new Error(`upstream API 名称重复: ${apiName}`);
  }
  api.name = apiName;
  apiNames.add(apiName);
  apiIpVersions.set(apiName, parseIpVersions(api));
  apiRequestCounters[apiName] = {
    count: 0,
    windowStartTime: Date.now(),
    isAvailable: api.enabled,
  };
});

function parseIpVersions(api) {
  if (api.ip_versions === undefined) {
    return new Set(IP_VERSION_VALUES.values());
  }
  if (typeof api.ip_versions !== "string") {
    throw new Error(`API ${api.name} 的 ip_versions 必须是逗号分隔的字符串`);
  }
  const configuredVersions = api.ip_versions
    .split(",")
    .map((version) => version.trim().toLowerCase())
    .filter(Boolean);
  const unknownVersion = configuredVersions.find(
    (version) => !IP_VERSION_VALUES.has(version),
  );
  if (unknownVersion) {
    throw new Error(
      `API ${api.name} 的 ip_versions 包含未知值: ${unknownVersion}`,
    );
  }
  return new Set(
    configuredVersions.map((version) => IP_VERSION_VALUES.get(version)),
  );
}

function supportsIpVersion(apiName, ipVersion) {
  return apiIpVersions.get(apiName)?.has(ipVersion) === true;
}

function resetRequestCounter(apiName) {
  const api = config.upstream_apis.find((a) => a.name === apiName);
  if (!api) return;
  apiRequestCounters[apiName] = {
    count: 0,
    windowStartTime: Date.now(),
    isAvailable: api.enabled,
  };
}

function isApiAvailable(apiName) {
  const api = config.upstream_apis.find((a) => a.name === apiName);
  if (!api || !api.enabled) return false;
  const counter = apiRequestCounters[apiName];
  if (!counter) return false;
  const now = Date.now();
  if (now - counter.windowStartTime > api.time_window * 1000) {
    resetRequestCounter(apiName);
    return true;
  }
  return counter.count < api.max_requests;
}

function getAvailableApis(ipVersion) {
  return config.upstream_apis.filter(
    (api) => supportsIpVersion(api.name, ipVersion) && isApiAvailable(api.name),
  );
}

function selectNextApi(availableApis) {
  if (!availableApis || availableApis.length === 0) {
    return null;
  }
  if (availableApis.length === 1) {
    return availableApis[0];
  }
  const strategy = config.load_balance_strategy || "round_robin";
  switch (strategy) {
    case "random":
      return availableApis[Math.floor(Math.random() * availableApis.length)];
    case "least_used":
      return availableApis.reduce((least, current) => {
        const leastCount = apiRequestCounters[least.name].count;
        const currentCount = apiRequestCounters[current.name].count;
        return currentCount < leastCount ? current : least;
      });
    default:
      lastUsedApiIndex = (lastUsedApiIndex + 1) % availableApis.length;
      return availableApis[lastUsedApiIndex];
  }
}

function incrementApiCounter(apiName) {
  if (!apiRequestCounters[apiName]) return;
  apiRequestCounters[apiName].count++;
}

function getNestedValue(obj, path) {
  if (!path) return undefined;
  if (path.includes(",")) {
    const fields = path.split(",");
    return fields
      .map((field) => getNestedValue(obj, field.trim()))
      .filter((v) => v)
      .join("");
  }
  const parts = path.split(".");
  if (!parts || parts.length === 0) return undefined;
  return parts.reduce((o, k) => {
    if (o === null || o === undefined || typeof o !== "object")
      return undefined;
    return o[k];
  }, obj);
}

function applyFieldTemplate(value, variables) {
  let out = String(value ?? "");
  if (!variables) return out;
  for (const [k, v] of Object.entries(variables)) {
    out = out.replaceAll(
      `{${k}}`,
      v === undefined || v === null ? "" : String(v),
    );
  }
  return out;
}

function resolveFieldValue(data, apiField, variables) {
  if (apiField === undefined || apiField === null) return undefined;
  const raw = String(apiField);
  if (raw.includes(",")) {
    const fields = raw.split(",");
    return fields
      .map((field) => resolveFieldValue(data, field.trim(), variables))
      .filter((v) => v)
      .join("");
  }
  const directMatch = raw.match(/^\{([\w.-]+)\}$/);
  if (directMatch) {
    const name = directMatch[1];
    if (Object.prototype.hasOwnProperty.call(variables || {}, name)) {
      return variables[name];
    }
  }
  if (raw.includes("{") && raw.includes("}")) {
    const parts = raw.split(".").map((part) => {
      const m = part.match(/^\{([\w.-]+)\}$/);
      if (!m) return part;
      const key = m[1];
      if (!Object.prototype.hasOwnProperty.call(variables || {}, key))
        return undefined;
      return variables[key];
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
  const resolvedPath = applyFieldTemplate(raw, variables);
  return getNestedValue(data, resolvedPath);
}

function mapResponseToStandardFormat(data, fieldMapping, variables) {
  const result = {};
  for (const [standardField, apiField] of Object.entries(fieldMapping)) {
    result[standardField] = resolveFieldValue(data, apiField, variables);
  }
  return result;
}

function expandIpv6ToPrefix(ip, groupCount) {
  let groups;
  const doubleColon = ip.indexOf("::");
  if (doubleColon === -1) {
    groups = ip.split(":");
  } else {
    const head = ip.slice(0, doubleColon).split(":").filter(Boolean);
    const tail = ip
      .slice(doubleColon + 2)
      .split(":")
      .filter(Boolean);
    const missingGroups = 8 - head.length - tail.length;
    if (missingGroups < 0) {
      throw new Error("IPv6 地址分组数量无效");
    }
    groups = head.concat(new Array(missingGroups).fill("0"), tail);
  }
  return groups
    .map((group) => group.padStart(4, "0"))
    .slice(0, groupCount)
    .join(":");
}

function getIpv6PrefixKey(ip) {
  const address = ip.split("%", 1)[0];
  try {
    const canonical = new URL(`http://[${address}]`).hostname
      .slice(1, -1)
      .toLowerCase();
    return `${expandIpv6ToPrefix(canonical, 3)}/48`;
  } catch {
    logger.warn(`IPv6缓存键规范化失败，使用原始地址作为缓存键`, { ip });
    return ip;
  }
}

function getCacheKey(ip) {
  const ipStr = String(ip || "").trim();
  const match = ipStr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (match) {
    const parts = match.slice(1).map(Number);
    if (parts.every((n) => !Number.isNaN(n) && n >= 0 && n <= 255)) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    }
  }
  if (net.isIP(ipStr) === 6) {
    return getIpv6PrefixKey(ipStr);
  }
  return ipStr;
}

async function getFromCache(ip) {
  const key = CACHE_PREFIX + getCacheKey(ip);
  const cached = await cache.get(key);
  if (
    !cached ||
    typeof cached !== "object" ||
    Array.isArray(cached) ||
    !Object.prototype.hasOwnProperty.call(cached, "source") ||
    typeof cached.source !== "string" ||
    !cached.source.trim() ||
    !Object.prototype.hasOwnProperty.call(cached, "data") ||
    !cached.data ||
    typeof cached.data !== "object" ||
    Array.isArray(cached.data)
  )
    return null;
  const data = {};
  config.response_fields.forEach((field) => {
    if (
      field !== "__proto__" &&
      field !== "constructor" &&
      field !== "prototype" &&
      Object.prototype.hasOwnProperty.call(cached.data, field)
    ) {
      const value = cached.data[field];
      if (
        typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value))
      ) {
        data[field] = value;
      }
    }
  });
  if (config.response_fields.includes("ip")) {
    data.ip = ip;
  }
  return { source: cached.source.trim(), data };
}

async function saveToCache(ip, data) {
  const key = CACHE_PREFIX + getCacheKey(ip);
  await cache.set(key, data, cacheTtl);
}

async function safeQueryIpInfo(ip, apiConfig) {
  if (!isApiAvailable(apiConfig.name)) {
    throw new Error(`API ${apiConfig.name} 不可用`);
  }
  incrementApiCounter(apiConfig.name);
  try {
    const url = apiConfig.url.replaceAll("{ip}", encodeURIComponent(ip));
    const response = await axios.get(url, {
      timeout: config.default_timeout,
      headers: {
        Accept: "application/json",
        "User-Agent": "api-server/1.0",
      },
      maxContentLength: MAX_RESPONSE_BYTES,
      maxBodyLength: MAX_RESPONSE_BYTES,
    });
    const standardData = mapResponseToStandardFormat(
      response.data,
      apiConfig.field_mapping,
      { ip },
    );
    const filteredData = {};
    config.response_fields.forEach((field) => {
      if (standardData[field] !== undefined) {
        filteredData[field] = standardData[field];
      }
    });
    return {
      source: apiConfig.name,
      data: filteredData,
    };
  } catch (error) {
    const err = new Error(`查询失败: ${error.message}`);
    err.source = apiConfig.name;
    throw err;
  }
}

function isIpv4MappedIpv6(ip) {
  if (net.isIP(ip) !== 6) {
    return false;
  }
  const address = ip.split("%", 1)[0];
  try {
    const hostname = new URL(`http://[${address}]`).hostname.toLowerCase();
    return /^\[::ffff:[\da-f]{1,4}:[\da-f]{1,4}\]$/.test(hostname);
  } catch {
    return false;
  }
}

function parseIp(ip) {
  const input = String(ip || "").trim();
  const normalizedIp = input.includes(":") ? input.split("%", 1)[0] : input;
  const ipVersion = net.isIP(normalizedIp);
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

async function queryProviders(normalizedIp, ipVersion) {
  let availableApis = getAvailableApis(ipVersion);
  if (availableApis.length === 0) {
    const err = new Error(`没有支持 IPv${ipVersion} 的可用API`);
    err.source = "系统";
    err.statusCode = 503;
    throw err;
  }
  let result;
  let lastError;
  let retryRound = 0;
  const triedApis = new Set();
  while (retryRound <= config.retry_count) {
    availableApis = getAvailableApis(ipVersion).filter(
      (api) => !triedApis.has(api.name),
    );
    if (availableApis.length === 0) {
      if (retryRound < config.retry_count) {
        triedApis.clear();
        availableApis = getAvailableApis(ipVersion);
        retryRound++;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } else {
        break;
      }
    }
    if (availableApis.length === 0) {
      break;
    }
    const selectedApi = selectNextApi(availableApis);
    if (!selectedApi) {
      break;
    }
    try {
      result = await safeQueryIpInfo(normalizedIp, selectedApi);
      logger.debug(`IP查询成功`, { source: result.source });
      try {
        await saveToCache(normalizedIp, result);
      } catch (error) {
        logger.warn("IP缓存写入失败", { error: error.message });
      }
      return result;
    } catch (error) {
      logger.warn(`IP查询上游失败`, {
        source: selectedApi.name,
        error: error.message,
        attempt: retryRound + 1,
      });
      lastError = error;
      triedApis.add(selectedApi.name);
    }
  }
  if (lastError) {
    throw lastError;
  } else {
    const err = new Error("查询失败");
    err.source = "系统";
    err.statusCode = 503;
    throw err;
  }
}

async function waitForCachedResult(ip) {
  const deadline = Date.now() + LOCK_TTL * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cachedData = await getFromCache(ip);
    if (cachedData) return cachedData;
  }
  return null;
}

async function queryIpInfoWithRetry(ip) {
  const { normalizedIp, ipVersion } = parseIp(ip);
  const cachedData = await getFromCache(normalizedIp);
  if (cachedData) {
    logger.debug("IP缓存命中");
    return cachedData;
  }

  const key = getCacheKey(normalizedIp);
  if (inflightQueries.has(key)) {
    const result = await inflightQueries.get(key);
    const cached = await getFromCache(normalizedIp);
    if (cached) return cached;
    return {
      source: result.source,
      data: {
        ...result.data,
        ...(config.response_fields.includes("ip") ? { ip: normalizedIp } : {}),
      },
    };
  }

  const query = (async () => {
    const lockKey = LOCK_PREFIX + key;
    const lockToken = crypto.randomUUID();
    let locked = await cache.setNX(lockKey, lockToken, LOCK_TTL);
    try {
      if (!locked) {
        const waitedResult = await waitForCachedResult(normalizedIp);
        if (waitedResult) return waitedResult;
        locked = await cache.setNX(lockKey, lockToken, LOCK_TTL);
        if (!locked) {
          const error = new Error("相同网段查询正在处理中");
          error.source = "系统";
          error.statusCode = 503;
          throw error;
        }
      }
      return await queryProviders(normalizedIp, ipVersion);
    } finally {
      if (locked) {
        try {
          await cache.delIfValue(lockKey, lockToken);
        } catch (error) {
          logger.warn("IP查询锁释放失败", { error: error.message });
        }
      }
    }
  })();
  inflightQueries.set(key, query);
  try {
    return await query;
  } finally {
    inflightQueries.delete(key);
  }
}

function getClientIp(req) {
  return req.ip || "";
}

async function handleIpQuery(ip, res) {
  try {
    const result = await queryIpInfoWithRetry(ip);
    res.json(result);
  } catch (error) {
    const body = { error: error.message };
    if (error.source) body.source = error.source;
    res.status(error.statusCode || 500).json(body);
  }
}

router.get("/", async (req, res) => {
  const queryIp = req.query.ip;
  if (queryIp) {
    return handleIpQuery(queryIp, res);
  } else {
    const clientIp = getClientIp(req);
    return handleIpQuery(clientIp, res);
  }
});

router.get("/:ip", async (req, res) => {
  const ip = req.params.ip;
  return handleIpQuery(ip, res);
});

module.exports = router;
module.exports.queryIpInfoWithRetry = queryIpInfoWithRetry;
module.exports.getClientIp = getClientIp;
module.exports.meta = {
  name: "IP 信息",
  description: "多上游容灾，自动重试",
  endpoints: [
    {
      method: "GET",
      path: "",
      description: "查询 当前/指定 IP",
      params: "?ip=x.x.x.x",
    },
    {
      method: "GET",
      path: "/",
      description: "查询 当前/指定 IP",
      params: "?ip=x.x.x.x",
    },
    {
      method: "GET",
      path: "/:ip",
      description: "查询指定 IP",
      params: "路径参数",
    },
  ],
};
