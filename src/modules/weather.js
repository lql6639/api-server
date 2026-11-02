import weatherConfig from "../../v1/weather/config.json" with { type: "json" };
import cityIdData from "../../v1/weather/week/city_id.json" with { type: "json" };
import cmoIdData from "../../v1/weather/week/cmo_id.json" with { type: "json" };
import { cacheGet, cacheSet } from "../lib/cache.js";
import { fetchJson } from "../lib/http.js";
import {
  createCityLookup,
  findIdByTailMatch,
  getClientIp,
  normalizeCityForMatch,
} from "../lib/ip.js";
import { queryIpInfoWithRetry } from "./ipinfo.js";

const WEEK_CACHE_PREFIX = "weather:week:";
const lookups = {
  city: createCityLookup(cityIdData, "city_code"),
  cmo: createCityLookup(cmoIdData, "id"),
};

const upstreamState = new Map();
let lastUsedUpstreamIndex = -1;
let lastVmyRequestAt = 0;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatDate(d) {
  return `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}`;
}

function formatWeekday(dateStr) {
  const parts = String(dateStr).split("/").map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return "";
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][d.getUTCDay()] || "";
}

function digitsOnly(value) {
  const m = String(value ?? "").match(/\d+/g);
  return m ? m.join("") : "";
}

function normalizeTemperature(value) {
  const match = String(value ?? "").match(/-?\d+(?:\.\d+)?/);
  return match ? match[0] : "";
}

function normalizeHumidity(value) {
  const d = digitsOnly(String(value ?? "").replace(/%/g, ""));
  return d ? `${d}%` : "";
}

function normalizeVisibility(value) {
  if (value === undefined || value === null) return "";
  const d = digitsOnly(value);
  return d ? `${d}km` : "";
}

function pickCityDisplay(city) {
  const c = String(city ?? "").trim();
  if (!c) return "";
  const normalized = c.replace(/,/g, "");
  const parts = normalized.split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1] || normalized;
  return last.replace(/[省]/g, "").trim().replace(/市$/g, "");
}

function applyTemplate(url, values) {
  let out = String(url);
  for (const [k, v] of Object.entries(values)) {
    out = out.split(`{${k}}`).join(v === undefined || v === null ? "" : String(v));
  }
  return out;
}

function stateOf(name) {
  if (!upstreamState.has(name)) {
    upstreamState.set(name, { failures: 0, unavailableUntil: 0 });
  }
  return upstreamState.get(name);
}

function markSuccess(name) {
  const st = stateOf(name);
  st.failures = 0;
  st.unavailableUntil = 0;
}

function markFailure(name) {
  const st = stateOf(name);
  st.failures = Math.min(10, (st.failures || 0) + 1);
  const base = Number(weatherConfig.realtime_failover_cooldown_ms) || 30000;
  const max = Number(weatherConfig.realtime_failover_cooldown_max_ms) || 300000;
  st.unavailableUntil = Date.now() + Math.min(max, base * 2 ** (st.failures - 1));
}

function isAvailable(name) {
  return Date.now() >= (stateOf(name).unavailableUntil || 0);
}

function credential(env, name) {
  const value = env?.[name];
  return value ? String(value).trim() : "";
}

async function fetchBingMsn(env, city) {
  if (!weatherConfig.bing?.enabled || !weatherConfig.msn?.enabled) return null;
  const appId = credential(env, "BING_APP_ID");
  const apiKey = credential(env, "MSN_API_KEY");
  if (!appId || !apiKey) return null;

  const bingUrl = applyTemplate(weatherConfig.bing.url, {
    appid: encodeURIComponent(appId),
    city: encodeURIComponent(city),
  });
  const bingData = await fetchJson(bingUrl, { timeout: 10000 });
  const first = Array.isArray(bingData?.value) ? bingData.value[0] : null;
  const lat = first?.geo?.latitude;
  const lon = first?.geo?.longitude;
  if (lat === undefined || lon === undefined) return null;

  const msnUrl = applyTemplate(weatherConfig.msn.url, {
    apikey: encodeURIComponent(apiKey),
    "value.geo.latitude,value.geo.longitude": `${lat},${lon}`,
  });
  const msnData = await fetchJson(msnUrl, { timeout: 10000 });
  const current = msnData?.responses?.[0]?.weather?.[0]?.current;
  if (!current) return null;

  return {
    provider: "msn",
    city: String(msnData?.responses?.[0]?.weather?.[0]?.source?.location?.Name || "").trim(),
    temperature: normalizeTemperature(current.temp),
    high: "",
    low: "",
    weather: String(current.pvdrCap || current.cap || "").trim(),
    wind: String(current.pvdrWindDir || "").trim(),
    windSpeed: String(current.pvdrWindSpd || "").trim(),
    visibility: normalizeVisibility(current.vis),
    humidity: normalizeHumidity(current.rh),
  };
}

async function fetchAmap(env, city) {
  if (!weatherConfig.amap?.enabled) return null;
  const key = credential(env, "AMAP_API_KEY");
  if (!key) return null;
  const url = applyTemplate(weatherConfig.amap.url, {
    key: encodeURIComponent(key),
    city: encodeURIComponent(city),
  });
  const data = await fetchJson(url, { timeout: 10000 });
  const live = Array.isArray(data?.lives) ? data.lives[0] : null;
  if (!live) return null;
  const wind = String(live.winddirection || "").trim();
  return {
    provider: "amap",
    city: String(live.city || "").trim(),
    temperature: normalizeTemperature(live.temperature),
    high: "",
    low: "",
    weather: String(live.weather || "").trim(),
    wind: wind ? `${wind}风` : "",
    windSpeed: String(live.windpower || "").trim(),
    visibility: "",
    humidity: normalizeHumidity(live.humidity),
  };
}

async function fetchVmy(city) {
  if (!weatherConfig.vmy?.enabled) return null;
  const wait = 1000 - (Date.now() - lastVmyRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastVmyRequestAt = Date.now();

  const url = applyTemplate(weatherConfig.vmy.url, { city: encodeURIComponent(city) });
  const data = await fetchJson(url, { timeout: 10000 });
  const current = data?.data?.current || data?.current || data?.data || null;
  const temperature = normalizeTemperature(
    current?.temp ?? current?.wendu ?? current?.temperature ?? data?.data?.wendu,
  );
  const text = String(current?.weather || current?.cap || current?.type || "").trim();
  if (!temperature && !text) return null;
  return {
    provider: "vmy",
    city: String(data?.data?.city || data?.city || current?.city || "").trim(),
    temperature,
    high: "",
    low: "",
    weather: text,
    wind: String(current?.wind || current?.windDirection || "").trim(),
    windSpeed: String(current?.windSpeed || current?.windpower || "").trim(),
    visibility: normalizeVisibility(current?.visibility),
    humidity: normalizeHumidity(current?.humidity),
  };
}

async function fetchSuyan(city) {
  if (!weatherConfig.suyan?.enabled) return null;
  const url = applyTemplate(weatherConfig.suyan.url, { city: encodeURIComponent(city) });
  const data = await fetchJson(url, { timeout: 10000 });
  const current = data?.data?.current || data?.current || null;
  const base = data?.data || data;
  const temperature = normalizeTemperature(current?.temp ?? base?.temp);
  const text = String(current?.weather || base?.weather || "").trim();
  if (!temperature && !text) return null;
  return {
    provider: "suyan",
    city: String(base?.city || "").trim(),
    temperature,
    high: "",
    low: "",
    weather: text,
    wind: String(current?.wind || base?.wind || "").trim(),
    windSpeed: String(current?.windSpeed || base?.windSpeed || "").trim(),
    visibility: normalizeVisibility(current?.visibility),
    humidity: normalizeHumidity(current?.humidity),
  };
}

async function queryRealtime(env, city) {
  const upstreams = [
    {
      name: "bing_msn",
      enabled: Boolean(
        weatherConfig.bing?.enabled &&
          weatherConfig.msn?.enabled &&
          credential(env, "BING_APP_ID") &&
          credential(env, "MSN_API_KEY"),
      ),
      fn: () => fetchBingMsn(env, city),
    },
    {
      name: "amap",
      enabled: Boolean(weatherConfig.amap?.enabled && credential(env, "AMAP_API_KEY")),
      fn: () => fetchAmap(env, city),
    },
    { name: "vmy", enabled: Boolean(weatherConfig.vmy?.enabled), fn: () => fetchVmy(city) },
    { name: "suyan", enabled: Boolean(weatherConfig.suyan?.enabled), fn: () => fetchSuyan(city) },
  ];

  const retryCount = Number.isFinite(Number(weatherConfig.realtime_retry_count))
    ? Number(weatherConfig.realtime_retry_count)
    : Number.isFinite(Number(weatherConfig.retry_count))
      ? Number(weatherConfig.retry_count)
      : 2;

  let tried = new Set();
  let lastError = null;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    let available = upstreams
      .filter((u) => u.enabled && isAvailable(u.name) && !tried.has(u.name));
    if (available.length === 0) {
      if (attempt < retryCount) {
        tried = new Set();
        continue;
      }
      break;
    }
    if (available.length > 1) {
      lastUsedUpstreamIndex = (lastUsedUpstreamIndex + 1) % available.length;
    }
    const selected = available[available.length > 1 ? lastUsedUpstreamIndex : 0];
    try {
      const data = await selected.fn();
      if (data) {
        markSuccess(selected.name);
        return data;
      }
      tried.add(selected.name);
    } catch (e) {
      lastError = e;
      markFailure(selected.name);
      tried.add(selected.name);
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function buildRealtime(c, env, cityQuery) {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const ip = c.req.query("ip") || getClientIp(c.req.raw);
  let result = null;
  try {
    result = await queryRealtime(env, cityQuery);
  } catch {
    result = null;
  }
  if (!result) return null;
  return {
    ip,
    city: pickCityDisplay(result.city) || pickCityDisplay(cityQuery),
    high: String(result.high || ""),
    low: String(result.low || ""),
    temperature: String(result.temperature || ""),
    weather: String(result.weather || ""),
    wind: String(result.wind || ""),
    windSpeed: String(result.windSpeed || ""),
    visibility: String(result.visibility || ""),
    humidity: String(result.humidity || ""),
    time: `${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())}:${pad2(now.getUTCSeconds())}`,
    date: formatDate(now),
  };
}

function normalizeWeek(value) {
  if (!Array.isArray(value)) return null;
  const week = value.slice(0, 7).reduce((acc, item) => {
    if (!item || typeof item !== "object") return acc;
    const date = String(item.date || "").trim();
    if (!date) return acc;
    acc.push({
      date,
      wind: String(item.wind || "").trim(),
      windSpeed: String(item.windSpeed || "").trim(),
      weather: String(item.weather || "").trim(),
      temperature: String(item.temperature || "").trim(),
      week: String(item.week || "").trim(),
    });
    return acc;
  }, []);
  return week.length > 0 ? week : null;
}

async function fetchCmaWeek(stationId) {
  if (!weatherConfig.cma?.enabled) return null;
  const url = applyTemplate(weatherConfig.cma.url, { cmo_id: stationId });
  const data = await fetchJson(url, { timeout: 10000 });
  const daily = Array.isArray(data?.data?.daily) ? data.data.daily : null;
  if (!daily) return null;

  return daily.slice(0, 7).map((item) => {
    const dayWind = String(item.dayWindDirection || "").trim();
    const nightWind = String(item.nightWindDirection || "").trim();
    const dayScale = String(item.dayWindScale || "").trim();
    const nightScale = String(item.nightWindScale || "").trim();
    const dayText = String(item.dayText || "").trim();
    const nightText = String(item.nightText || "").trim();
    const high = Number(normalizeTemperature(item.high));
    const low = Number(normalizeTemperature(item.low));
    const date = String(item.date || "").trim();
    return {
      date,
      wind: dayWind && nightWind && dayWind !== nightWind ? `${dayWind}转${nightWind}` : dayWind || nightWind,
      windSpeed: dayScale && nightScale && dayScale !== nightScale ? `${dayScale}转${nightScale}` : dayScale || nightScale,
      weather: dayText && nightText && dayText !== nightText ? `${dayText}转${nightText}` : dayText || nightText,
      temperature:
        Number.isFinite(high) && Number.isFinite(low) ? `${Math.round((high + low) / 2)}℃` : "",
      week: formatWeekday(date),
    };
  });
}

async function fetchSojsonWeek(cityId) {
  if (!weatherConfig.sojson?.enabled) return null;
  const url = applyTemplate(weatherConfig.sojson.url, { city_id: cityId });
  const data = await fetchJson(url, { timeout: 10000 });
  const forecast = Array.isArray(data?.data?.forecast) ? data.data.forecast : null;
  if (!forecast) return null;

  return forecast.slice(0, 7).map((item) => {
    const high = Number(normalizeTemperature(item.high));
    const low = Number(normalizeTemperature(item.low));
    return {
      date: String(item.ymd || "").trim().replace(/-/g, "/"),
      wind: String(item.fx || "").trim(),
      windSpeed: String(item.fl || "").trim(),
      weather: String(item.type || "").trim(),
      temperature:
        Number.isFinite(high) && Number.isFinite(low) ? `${Math.round((high + low) / 2)}℃` : "",
      week: String(item.week || "").trim(),
    };
  });
}

async function buildWeek(cityQuery) {
  const city = pickCityDisplay(cityQuery);
  const cacheKey = `${WEEK_CACHE_PREFIX}${encodeURIComponent(normalizeCityForMatch(cityQuery))}`;

  const cached = normalizeWeek(await cacheGet(cacheKey));
  if (cached) return cached;

  const stationId = findIdByTailMatch(cityQuery, lookups.cmo) || findIdByTailMatch(city, lookups.cmo);
  const sojsonCityId = findIdByTailMatch(cityQuery, lookups.city) || findIdByTailMatch(city, lookups.city);

  const providers = [];
  if (stationId) providers.push(() => fetchCmaWeek(stationId));
  if (sojsonCityId) providers.push(() => fetchSojsonWeek(sojsonCityId));

  for (const fn of providers) {
    try {
      const week = normalizeWeek(await fn());
      if (week) {
        const ttl = Number(weatherConfig.week_cache_ttl) > 0 ? Number(weatherConfig.week_cache_ttl) : 3600;
        await cacheSet(cacheKey, week, ttl);
        return week;
      }
    } catch {
      // 换下一个上游
    }
  }
  return null;
}

async function resolveCityQuery(c) {
  const queryCity = c.req.query("city");
  if (queryCity) return String(queryCity);
  const ip = c.req.query("ip") || getClientIp(c.req.raw);
  const info = await queryIpInfoWithRetry(ip);
  const city = String(info?.data?.city || "").replace(/省/g, "").trim();
  return pickCityDisplay(city) || city;
}

export async function handler(c, action = "") {
  const env = c.env || {};

  let cityQuery;
  try {
    cityQuery = await resolveCityQuery(c);
  } catch (e) {
    return Response.json(
      { success: false, message: String(e?.message || e) },
      { status: Number(e?.statusCode) || 500 },
    );
  }
  if (!cityQuery) {
    return Response.json(
      { success: false, message: "缺少city或无法通过IP解析城市" },
      { status: 400 },
    );
  }

  try {
    if (action === "realtime") {
      const realtime = await buildRealtime(c, env, cityQuery);
      if (!realtime) {
        return Response.json({ success: false, message: "上游天气接口不可用" }, { status: 502 });
      }
      return Response.json({ success: true, data: { realtime } });
    }

    if (action === "week") {
      const week = await buildWeek(cityQuery);
      if (!week || week.length === 0) {
        return Response.json(
          { success: false, message: "未找到城市ID或上游不可用" },
          { status: 404 },
        );
      }
      return Response.json({ success: true, data: { week } });
    }

    const [realtime, week] = await Promise.all([
      buildRealtime(c, env, cityQuery).catch(() => null),
      buildWeek(cityQuery).catch(() => null),
    ]);
    if (!realtime && (!week || week.length === 0)) {
      return Response.json({ success: false, message: "上游天气接口不可用" }, { status: 502 });
    }
    return Response.json({ success: true, data: { realtime: realtime || null, week: week || [] } });
  } catch (e) {
    return Response.json(
      { success: false, message: String(e?.message || e) },
      { status: Number(e?.statusCode) || 500 },
    );
  }
}

export const meta = {
  name: "天气",
  description: "IP 定位，实时 + 7 天",
  endpoints: [
    { method: "GET", path: "/", description: "实时 + 7 天", params: "?city=深圳" },
    { method: "GET", path: "/realtime", description: "仅实时", params: "?city=深圳" },
    { method: "GET", path: "/week", description: "仅 7 天", params: "?city=深圳" },
  ],
};
