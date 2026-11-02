const express = require("express");
const fs = require("fs");
const path = require("path");

const { getStore } = require("../../libs/cacheStore");
const HttpClient = require("../../utils/httpClient");
const logger = require("../../utils/logger");
const { getClientIp, queryIpInfoWithRetry } = require("../ipinfo");

const router = express.Router();
const config = require(path.join(__dirname, "config.json"));
const WEEK_CACHE_PREFIX = "weather:week:";

const realtimeUpstreamState = new Map();
let lastUsedRealtimeUpstreamIndex = -1;

function getRealtimeUpstreamState(name) {
  const key = String(name || "").trim();
  if (!key) return { failures: 0, unavailableUntil: 0 };
  if (!realtimeUpstreamState.has(key)) {
    realtimeUpstreamState.set(key, { failures: 0, unavailableUntil: 0 });
  }
  return realtimeUpstreamState.get(key);
}

function markRealtimeUpstreamSuccess(name) {
  const st = getRealtimeUpstreamState(name);
  if (st.failures > 0) {
    logger.info(`上游恢复: ${name}`);
  }
  st.failures = 0;
  st.unavailableUntil = 0;
}

function markRealtimeUpstreamFailure(name) {
  const st = getRealtimeUpstreamState(name);
  st.failures = Math.min(10, (st.failures || 0) + 1);
  const base = Number(config?.realtime_failover_cooldown_ms) || 30000;
  const max = Number(config?.realtime_failover_cooldown_max_ms) || 300000;
  const cooldown = Math.min(
    max,
    base * Math.pow(2, Math.max(0, st.failures - 1)),
  );
  st.unavailableUntil = Date.now() + cooldown;
  logger.warn(`上游故障: ${name}`, {
    failures: st.failures,
    cooldown_ms: cooldown,
  });
}

function isRealtimeUpstreamAvailable(name) {
  const st = getRealtimeUpstreamState(name);
  return Date.now() >= (st.unavailableUntil || 0);
}

function selectNextRealtimeUpstream(available) {
  if (!available || available.length === 0) return null;
  if (available.length === 1) return available[0];
  lastUsedRealtimeUpstreamIndex =
    (lastUsedRealtimeUpstreamIndex + 1) % available.length;
  return available[lastUsedRealtimeUpstreamIndex];
}

let weatherLookupsPromise = null;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatDate(d) {
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

function formatTime(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatWeekday(dateStr) {
  const parts = String(dateStr)
    .split("/")
    .map((v) => Number(v));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return "";
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  const map = [
    "星期日",
    "星期一",
    "星期二",
    "星期三",
    "星期四",
    "星期五",
    "星期六",
  ];
  return map[d.getUTCDay()] || "";
}

function digitsOnly(value) {
  const s = String(value ?? "");
  const m = s.match(/\d+/g);
  return m ? m.join("") : "";
}

function normalizeCityForMatch(value) {
  return String(value ?? "")
    .trim()
    .replace(/[\s,，]/g, "")
    .replace(/[省市]/g, "");
}

function createCityLookup(items, valueField) {
  const exact = new Map();
  let maxNameLength = 0;
  items.forEach((item) => {
    const name = String(item?.name || "").trim();
    const value = String(item?.[valueField] || "").trim();
    if (!name || !value) return;
    const variants = new Set([name, normalizeCityForMatch(name)]);
    variants.forEach((variant) => {
      if (!variant) return;
      if (!exact.has(variant)) exact.set(variant, value);
      maxNameLength = Math.max(maxNameLength, variant.length);
    });
  });
  return { exact, maxNameLength };
}

async function loadWeatherLookups() {
  if (!weatherLookupsPromise) {
    weatherLookupsPromise = Promise.all([
      fs.promises.readFile(
        path.join(__dirname, "week", "city_id.json"),
        "utf-8",
      ),
      fs.promises.readFile(
        path.join(__dirname, "week", "cmo_id.json"),
        "utf-8",
      ),
    ]).then(([cityIdRaw, cmoIdRaw]) => ({
      city: createCityLookup(JSON.parse(cityIdRaw), "city_code"),
      cmo: createCityLookup(JSON.parse(cmoIdRaw), "id"),
    }));
  }
  return weatherLookupsPromise;
}

function findIdByTailMatch(name, lookup) {
  const raw = String(name ?? "").trim();
  if (!raw) return "";

  const base1 = raw;
  const base2 = normalizeCityForMatch(raw);
  const base3 = base2.replace(/区$/g, "").replace(/市$/g, "");
  const bases = [base1, base2, base3].filter(Boolean);

  for (const base of bases) {
    if (lookup.exact.has(base)) return lookup.exact.get(base);
  }

  for (const base of bases) {
    const maxLen = Math.min(4, base.length);
    for (let len = 2; len <= maxLen; len++) {
      const cand = base.slice(-len);
      if (lookup.exact.has(cand)) return lookup.exact.get(cand);
    }
  }

  for (const base of bases) {
    const maxLength = Math.min(base.length, lookup.maxNameLength);
    for (let length = maxLength; length >= 1; length--) {
      const candidate = base.slice(-length);
      if (lookup.exact.has(candidate)) return lookup.exact.get(candidate);
    }
  }

  return "";
}

function applyTemplate(url, values) {
  let out = String(url);
  for (const [k, v] of Object.entries(values)) {
    out = out.replaceAll(`{${k}}`, v);
  }
  return out;
}

let lastVmyRequestAt = 0;
let vmyQueue = Promise.resolve();
let vmyQueueSize = 0;
async function throttleVmy() {
  const configuredLimit = Number(config?.vmy_queue_limit);
  const queueLimit = configuredLimit > 0 ? configuredLimit : 100;
  if (vmyQueueSize >= queueLimit) {
    throw new Error("52vmy 请求队列已满");
  }
  vmyQueueSize++;
  const scheduled = vmyQueue.then(async () => {
    const wait = Math.max(0, 1000 - (Date.now() - lastVmyRequestAt));
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    lastVmyRequestAt = Date.now();
  });
  vmyQueue = scheduled.catch(() => {});
  try {
    await scheduled;
  } finally {
    vmyQueueSize--;
  }
}

async function resolveCityFromIp(ip) {
  const result = await queryIpInfoWithRetry(ip);
  const city = result?.data?.city ? String(result.data.city) : "";
  return city.replace(/[省]/g, "").trim();
}

function pickCityDisplay(city) {
  const c = String(city ?? "").trim();
  if (!c) return "";
  const normalized = c.replace(/,/g, "");
  const parts = normalized.split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1] || normalized;
  const clean = last.replace(/[省]/g, "").trim();
  return clean.replace(/市$/g, "");
}

function normalizeHumidity(value) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  const v = s.replace(/%/g, "");
  const d = digitsOnly(v);
  return d ? `${d}%` : "";
}

function normalizeVisibility(value) {
  if (value === undefined || value === null) return "";
  const s = String(value).trim();
  if (!s) return "";
  const d = digitsOnly(s);
  if (!d) return "";
  if (s.toLowerCase().includes("km")) return `${d}km`;
  return `${d}km`;
}

function normalizeTemperature(value) {
  const match = String(value ?? "").match(/-?\d+(?:\.\d+)?/);
  return match ? match[0] : "";
}

function normalizeWeek(value) {
  if (!Array.isArray(value)) return null;
  const week = value.slice(0, 7).reduce((result, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return result;
    const date = String(item.date || "").trim();
    if (!date) return result;
    result.push({
      date,
      wind: String(item.wind || "").trim(),
      windSpeed: String(item.windSpeed || "").trim(),
      weather: String(item.weather || "").trim(),
      temperature: String(item.temperature || "").trim(),
      week: String(item.week || "").trim(),
    });
    return result;
  }, []);
  return week.length > 0 ? week : null;
}

function getWeatherCredential(name) {
  const value = process.env[name];
  return value ? String(value).trim() : "";
}

async function fetchBingMsnRealtime(http, cityQuery) {
  if (!config?.bing?.enabled || !config?.msn?.enabled) return null;
  const appId = getWeatherCredential("BING_APP_ID");
  const apiKey = getWeatherCredential("MSN_API_KEY");
  if (!appId || !apiKey) return null;
  const bingUrl = applyTemplate(config.bing.url, {
    appid: encodeURIComponent(appId),
    city: encodeURIComponent(cityQuery),
  });
  const bingData = await http.get(bingUrl);
  const first = Array.isArray(bingData?.value) ? bingData.value[0] : null;
  const lat = first?.geo?.latitude;
  const lon = first?.geo?.longitude;
  if (lat === undefined || lon === undefined) return null;

  const msnUrl = applyTemplate(config.msn.url, {
    apikey: encodeURIComponent(apiKey),
    "value.geo.latitude,value.geo.longitude": `${lat},${lon}`,
  });

  const msnData = await http.get(msnUrl);
  const current = msnData?.responses?.[0]?.weather?.[0]?.current;
  const locationName =
    msnData?.responses?.[0]?.weather?.[0]?.source?.location?.Name;
  if (!current) return null;

  const temp = normalizeTemperature(current.temp);
  const weather = String(current.pvdrCap || current.cap || "").trim();
  const wind = String(current.pvdrWindDir || "").trim();
  const windSpeed = String(current.pvdrWindSpd || "").trim();
  const humidity = normalizeHumidity(current.rh);
  const visibility = normalizeVisibility(current.vis);

  return {
    provider: "msn",
    city: String(locationName || "").trim(),
    temperature: temp,
    high: "",
    low: "",
    weather,
    wind,
    windSpeed,
    visibility,
    humidity,
  };
}

async function fetchAmapRealtime(http, cityQuery) {
  if (!config?.amap?.enabled) return null;
  const key = getWeatherCredential("AMAP_API_KEY");
  if (!key) return null;
  const url = applyTemplate(config.amap.url, {
    key: encodeURIComponent(key),
    city: encodeURIComponent(cityQuery),
  });
  const data = await http.get(url);
  const live = Array.isArray(data?.lives) ? data.lives[0] : null;
  if (!live) return null;

  const temp = normalizeTemperature(live.temperature);
  const weather = String(live.weather || "").trim();
  const wind = String(live.winddirection || "").trim();
  const windSpeed = String(live.windpower || "").trim();
  const humidity = normalizeHumidity(live.humidity);

  return {
    provider: "amap",
    city: String(live.city || "").trim(),
    temperature: temp,
    high: "",
    low: "",
    weather,
    wind: wind ? `${wind}风` : "",
    windSpeed,
    visibility: "",
    humidity,
  };
}

function extractVmyData(data) {
  const current = data?.data?.current || data?.current || data?.data || null;
  const city = data?.data?.city || data?.city || current?.city || "";
  const temperature = normalizeTemperature(
    current?.temp ??
      current?.wendu ??
      current?.temperature ??
      data?.data?.wendu,
  );
  const weather = String(
    current?.weather || current?.cap || current?.type || "",
  ).trim();
  const wind = String(current?.wind || current?.windDirection || "").trim();
  const windSpeed = String(
    current?.windSpeed || current?.windpower || "",
  ).trim();
  const humidity = normalizeHumidity(current?.humidity);
  const visibility = normalizeVisibility(current?.visibility);

  if (!temperature && !weather) return null;

  return {
    provider: "vmy",
    city: String(city || "").trim(),
    temperature,
    high: "",
    low: "",
    weather,
    wind,
    windSpeed,
    visibility,
    humidity,
  };
}

async function fetchVmyRealtime(http, cityQuery) {
  if (!config?.vmy?.enabled) return null;
  await throttleVmy();
  const url = applyTemplate(config.vmy.url, {
    city: encodeURIComponent(cityQuery),
  });
  const data = await http.get(url);
  return extractVmyData(data);
}

async function fetchSuyanRealtime(http, cityQuery) {
  if (!config?.suyan?.enabled) return null;
  const url = applyTemplate(config.suyan.url, {
    city: encodeURIComponent(cityQuery),
  });
  const data = await http.get(url);
  const current = data?.data?.current || data?.current || null;
  const base = data?.data || data;

  const city = base?.city || "";
  const temperature = normalizeTemperature(current?.temp ?? base?.temp);
  const weather = String(current?.weather || base?.weather || "").trim();
  const wind = String(current?.wind || base?.wind || "").trim();
  const windSpeed = String(current?.windSpeed || base?.windSpeed || "").trim();
  const visibility = normalizeVisibility(current?.visibility);
  const humidity = normalizeHumidity(current?.humidity);

  if (!temperature && !weather) return null;

  return {
    provider: "suyan",
    city: String(city || "").trim(),
    temperature,
    high: "",
    low: "",
    weather,
    wind,
    windSpeed,
    visibility,
    humidity,
  };
}

async function queryRealtimeWithRetry(http, cityQuery) {
  const bingMsnEnabled = Boolean(
    config?.bing?.enabled &&
    config?.msn?.enabled &&
    getWeatherCredential("BING_APP_ID") &&
    getWeatherCredential("MSN_API_KEY"),
  );
  const amapEnabled = Boolean(
    config?.amap?.enabled && getWeatherCredential("AMAP_API_KEY"),
  );
  const upstreams = [
    {
      name: "bing_msn",
      enabled: bingMsnEnabled,
      fn: () => fetchBingMsnRealtime(http, cityQuery),
    },
    {
      name: "amap",
      enabled: amapEnabled,
      fn: () => fetchAmapRealtime(http, cityQuery),
    },
    {
      name: "vmy",
      enabled: Boolean(config?.vmy?.enabled),
      fn: () => fetchVmyRealtime(http, cityQuery),
    },
    {
      name: "suyan",
      enabled: Boolean(config?.suyan?.enabled),
      fn: () => fetchSuyanRealtime(http, cityQuery),
    },
  ];

  const retryCount = Number.isFinite(Number(config?.realtime_retry_count))
    ? Number(config.realtime_retry_count)
    : Number.isFinite(Number(config?.retry_count))
      ? Number(config.retry_count)
      : 2;

  let tried = new Set();
  let lastError;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    const available = upstreams
      .filter((u) => u.enabled)
      .filter((u) => isRealtimeUpstreamAvailable(u.name))
      .filter((u) => !tried.has(u.name));

    if (available.length === 0) {
      if (attempt < retryCount) {
        tried.clear();
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      break;
    }

    const selected = selectNextRealtimeUpstream(available);
    if (!selected) break;

    logger.debug(`实时天气上游: ${selected.name}`, {
      attempt: attempt + 1,
      available: available.map((u) => u.name).join(","),
    });

    try {
      const data = await selected.fn();
      if (data) {
        markRealtimeUpstreamSuccess(selected.name);
        return data;
      }
      tried.add(selected.name);
    } catch (e) {
      lastError = e;
      markRealtimeUpstreamFailure(selected.name);
      tried.add(selected.name);
    }
  }

  if (lastError) throw lastError;
  return null;
}

async function buildRealtime(req, cityQuery) {
  const http = new HttpClient({ timeout: 10000 });
  const now = new Date();

  const ip = req.query.ip ? String(req.query.ip) : getClientIp(req);
  const city = pickCityDisplay(cityQuery);

  let result = null;
  try {
    result = await queryRealtimeWithRetry(http, cityQuery);
  } catch (e) {
    logger.error(`实时天气查询失败: ${e?.message || e}`);
    result = null;
  }

  if (!result) {
    return null;
  }

  return {
    ip,
    city: pickCityDisplay(result.city) || city,
    high: String(result.high || ""),
    low: String(result.low || ""),
    temperature: String(result.temperature || ""),
    weather: String(result.weather || ""),
    wind: String(result.wind || ""),
    windSpeed: String(result.windSpeed || ""),
    visibility: String(result.visibility || ""),
    humidity: String(result.humidity || ""),
    time: formatTime(now),
    date: formatDate(now),
  };
}

async function fetchCmaWeek(http, stationId) {
  if (!config?.cma?.enabled) return null;
  const url = applyTemplate(config.cma.url, { cmo_id: stationId });
  const data = await http.get(url);
  const daily = Array.isArray(data?.data?.daily) ? data.data.daily : null;
  if (!daily) return null;

  const week = daily.slice(0, 7).map((item) => {
    const date = String(item.date || "").trim();
    const dayWind = String(item.dayWindDirection || "").trim();
    const nightWind = String(item.nightWindDirection || "").trim();
    const wind =
      dayWind && nightWind && dayWind !== nightWind
        ? `${dayWind}转${nightWind}`
        : dayWind || nightWind;

    const dayScale = String(item.dayWindScale || "").trim();
    const nightScale = String(item.nightWindScale || "").trim();
    const windSpeed =
      dayScale && nightScale && dayScale !== nightScale
        ? `${dayScale}转${nightScale}`
        : dayScale || nightScale;

    const dayText = String(item.dayText || "").trim();
    const nightText = String(item.nightText || "").trim();
    const weather =
      dayText && nightText && dayText !== nightText
        ? `${dayText}转${nightText}`
        : dayText || nightText;

    const highValue = normalizeTemperature(item.high);
    const lowValue = normalizeTemperature(item.low);
    const high = highValue ? Number(highValue) : Number.NaN;
    const low = lowValue ? Number(lowValue) : Number.NaN;
    const avg =
      Number.isFinite(high) && Number.isFinite(low)
        ? Math.round((high + low) / 2)
        : null;
    const temperature = avg !== null ? `${avg}℃` : "";

    return {
      date,
      wind,
      windSpeed,
      weather,
      temperature,
      week: formatWeekday(date),
    };
  });

  return week;
}

async function fetchSojsonWeek(http, cityId) {
  if (!config?.sojson?.enabled) return null;
  const url = applyTemplate(config.sojson.url, { city_id: cityId });
  const data = await http.get(url);
  const forecast = Array.isArray(data?.data?.forecast)
    ? data.data.forecast
    : null;
  if (!forecast) return null;

  return forecast.slice(0, 7).map((item) => {
    const date = String(item.ymd || "")
      .trim()
      .replaceAll("-", "/");
    const highValue = normalizeTemperature(item.high);
    const lowValue = normalizeTemperature(item.low);
    const high = highValue ? Number(highValue) : Number.NaN;
    const low = lowValue ? Number(lowValue) : Number.NaN;
    const temperature =
      Number.isFinite(high) && Number.isFinite(low)
        ? `${Math.round((high + low) / 2)}℃`
        : "";

    return {
      date,
      wind: String(item.fx || "").trim(),
      windSpeed: String(item.fl || "").trim(),
      weather: String(item.type || "").trim(),
      temperature,
      week: String(item.week || "").trim(),
    };
  });
}

async function buildWeek(cityQuery) {
  const http = new HttpClient({ timeout: 10000 });
  const city = pickCityDisplay(cityQuery);
  const cacheKey = `${WEEK_CACHE_PREFIX}${encodeURIComponent(normalizeCityForMatch(cityQuery))}`;
  let cache = null;
  try {
    cache = getStore();
    const cached = normalizeWeek(await cache.get(cacheKey));
    if (cached) return cached;
  } catch {
    cache = null;
  }

  const lookups = await loadWeatherLookups();

  const stationId =
    findIdByTailMatch(cityQuery, lookups.cmo) ||
    findIdByTailMatch(city, lookups.cmo);
  const sojsonCityId =
    findIdByTailMatch(cityQuery, lookups.city) ||
    findIdByTailMatch(city, lookups.city);

  logger.debug(`城市ID匹配: ${cityQuery}`, { stationId, sojsonCityId });

  const providers = [];
  if (stationId) providers.push(() => fetchCmaWeek(http, stationId));
  if (sojsonCityId) providers.push(() => fetchSojsonWeek(http, sojsonCityId));

  for (const fn of providers) {
    try {
      const week = normalizeWeek(await fn());
      if (week) {
        if (cache) {
          const configuredTtl = Number(config?.week_cache_ttl);
          try {
            await cache.set(
              cacheKey,
              week,
              configuredTtl > 0 ? configuredTtl : 3600,
            );
          } catch (error) {
            logger.warn("天气缓存写入失败", { error: error.message });
          }
        }
        return week;
      }
    } catch {}
  }

  return null;
}

async function resolveCityQuery(req) {
  const queryCity = req.query.city ? String(req.query.city) : "";
  if (queryCity) return queryCity;

  const queryIp = req.query.ip ? String(req.query.ip) : "";
  const ip = queryIp || getClientIp(req);
  const city = await resolveCityFromIp(ip);
  return pickCityDisplay(city) || city;
}

async function buildBoth(req, cityQuery) {
  const [realtimeSettled, weekSettled] = await Promise.allSettled([
    buildRealtime(req, cityQuery),
    buildWeek(cityQuery),
  ]);

  const realtime =
    realtimeSettled.status === "fulfilled" ? realtimeSettled.value : null;
  const week = weekSettled.status === "fulfilled" ? weekSettled.value : null;
  return {
    realtime: realtime || null,
    week: week || [],
  };
}

router.get("/realtime", async (req, res) => {
  try {
    const cityQuery = await resolveCityQuery(req);
    if (!cityQuery) {
      return res
        .status(400)
        .json({ success: false, message: "缺少city或无法通过IP解析城市" });
    }
    const realtime = await buildRealtime(req, cityQuery);
    if (!realtime) {
      return res
        .status(502)
        .json({ success: false, message: "上游天气接口不可用" });
    }
    res.json({ success: true, data: { realtime } });
  } catch (e) {
    res
      .status(e?.statusCode || 500)
      .json({ success: false, message: String(e?.message || e) });
  }
});

router.get("/week", async (req, res) => {
  try {
    const cityQuery = await resolveCityQuery(req);
    if (!cityQuery) {
      return res
        .status(400)
        .json({ success: false, message: "缺少city或无法通过IP解析城市" });
    }
    const week = await buildWeek(cityQuery);
    if (!week || week.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "未找到城市ID或上游不可用" });
    }
    res.json({ success: true, data: { week } });
  } catch (e) {
    res
      .status(e?.statusCode || 500)
      .json({ success: false, message: String(e?.message || e) });
  }
});

router.get("/", async (req, res) => {
  try {
    const cityQuery = await resolveCityQuery(req);
    if (!cityQuery) {
      return res
        .status(400)
        .json({ success: false, message: "缺少city或无法通过IP解析城市" });
    }
    const data = await buildBoth(req, cityQuery);
    if (!data.realtime && (!data.week || data.week.length === 0)) {
      return res
        .status(502)
        .json({ success: false, message: "上游天气接口不可用" });
    }
    res.json({ success: true, data });
  } catch (e) {
    res
      .status(e?.statusCode || 500)
      .json({ success: false, message: String(e?.message || e) });
  }
});

module.exports = router;
module.exports.meta = {
  name: "天气",
  description: "IP 定位，实时 + 7 天",
  endpoints: [
    {
      method: "GET",
      path: "/",
      description: "实时 + 7 天",
      params: "?city=深圳",
    },
    {
      method: "GET",
      path: "/realtime",
      description: "仅实时",
      params: "?city=深圳",
    },
    {
      method: "GET",
      path: "/week",
      description: "仅 7 天",
      params: "?city=深圳",
    },
  ],
};
