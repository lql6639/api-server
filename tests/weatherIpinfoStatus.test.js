"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const CACHE_STORE_PATH = require.resolve("../libs/cacheStore");
const WEATHER_CONFIG_PATH = require.resolve("../v1/weather/config.json");
const HTTP_CLIENT_PATH = require.resolve("../utils/httpClient");
const IPINFO_PATH = require.resolve("../v1/ipinfo");
const LOGGER_PATH = require.resolve("../utils/logger");
const WEATHER_PATH = require.resolve("../v1/weather");
const WEATHER_MODULE_PATHS = [
  CACHE_STORE_PATH,
  WEATHER_CONFIG_PATH,
  HTTP_CLIENT_PATH,
  IPINFO_PATH,
  LOGGER_PATH,
  WEATHER_PATH,
];

function setCachedModule(modulePath, moduleExports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: moduleExports,
  };
}

function snapshotModules(modulePaths) {
  return new Map(
    modulePaths.map((modulePath) => [modulePath, require.cache[modulePath]]),
  );
}

function restoreModules(snapshot) {
  for (const [modulePath, cachedModule] of snapshot.entries()) {
    delete require.cache[modulePath];
    if (cachedModule) {
      require.cache[modulePath] = cachedModule;
    }
  }
}

function loadWeather(statusCode) {
  const snapshot = snapshotModules(WEATHER_MODULE_PATHS);
  delete require.cache[WEATHER_PATH];
  setCachedModule(IPINFO_PATH, {
    getClientIp() {
      return "203.0.113.30";
    },
    async queryIpInfoWithRetry() {
      const error = new Error(`ipinfo ${statusCode}`);
      error.statusCode = statusCode;
      throw error;
    },
  });

  try {
    const router = require(WEATHER_PATH);
    return {
      router,
      restore() {
        restoreModules(snapshot);
      },
    };
  } catch (error) {
    restoreModules(snapshot);
    throw error;
  }
}

function loadWeatherRealtime() {
  const snapshot = snapshotModules(WEATHER_MODULE_PATHS);
  const requests = [];
  const config = {
    amap: {
      enabled: true,
      url: "https://amap.test/weather?key={key}&city={city}",
    },
    bing: {
      enabled: true,
      url: "https://bing.test/places?appid={appid}&city={city}",
    },
    msn: {
      enabled: true,
      url: "https://msn.test/weather?apikey={apikey}&location={value.geo.latitude,value.geo.longitude}",
    },
    realtime_retry_count: 2,
    suyan: {
      enabled: true,
      url: "https://suyan.test/weather?city={city}",
    },
    vmy: {
      enabled: true,
      url: "https://vmy.test/weather?city={city}",
    },
  };

  class MockHttpClient {
    async get(url) {
      requests.push(url);
      if (url.startsWith("https://vmy.test/")) {
        return null;
      }
      if (url.startsWith("https://suyan.test/")) {
        return {
          data: {
            city: "深圳市",
            current: {
              temp: "24",
              weather: "晴",
            },
          },
        };
      }
      throw new Error(`Unexpected weather upstream: ${url}`);
    }
  }

  delete require.cache[WEATHER_PATH];
  setCachedModule(CACHE_STORE_PATH, {
    getStore() {
      throw new Error("Unexpected weather cache access");
    },
  });
  setCachedModule(WEATHER_CONFIG_PATH, config);
  setCachedModule(HTTP_CLIENT_PATH, MockHttpClient);
  setCachedModule(IPINFO_PATH, {
    getClientIp() {
      return "203.0.113.30";
    },
    async queryIpInfoWithRetry() {
      throw new Error("Unexpected IP lookup");
    },
  });
  setCachedModule(LOGGER_PATH, {
    debug() {},
    error() {},
    info() {},
    warn() {},
  });

  try {
    const router = require(WEATHER_PATH);
    return {
      requests,
      router,
      restore() {
        restoreModules(snapshot);
      },
    };
  } catch (error) {
    restoreModules(snapshot);
    throw error;
  }
}

function getRouteHandler(router, routePath) {
  const layer = router.stack.find(
    (item) => item.route?.path === routePath && item.route.methods.get,
  );
  assert.ok(layer, `Missing GET route ${routePath}`);
  return layer.route.stack[0].handle;
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function invokeRoute(router, routePath) {
  const handler = getRouteHandler(router, routePath);
  const request = { query: { ip: "203.0.113.31" } };
  const response = createResponse();
  await handler(request, response);
  return response;
}

async function assertStatusPreserved(statusCode) {
  const loaded = loadWeather(statusCode);
  try {
    for (const routePath of ["/realtime", "/week", "/"]) {
      const response = await invokeRoute(loaded.router, routePath);
      assert.strictEqual(response.statusCode, statusCode);
      assert.deepStrictEqual(response.body, {
        success: false,
        message: `ipinfo ${statusCode}`,
      });
    }
  } finally {
    loaded.restore();
  }
}

describe("weather ipinfo status propagation", () => {
  it("should preserve statusCode 400 on all three routes", async () => {
    await assertStatusPreserved(400);
  });

  it("should preserve statusCode 503 on all three routes", async () => {
    await assertStatusPreserved(503);
  });

  it("should fall back through vmy and suyan when credentialed providers are unavailable", async () => {
    const credentialNames = ["BING_APP_ID", "MSN_API_KEY", "AMAP_API_KEY"];
    const savedCredentials = new Map(
      credentialNames.map((name) => [name, process.env[name]]),
    );
    let context;

    for (const name of credentialNames) {
      delete process.env[name];
    }

    try {
      context = loadWeatherRealtime();
      const response = createResponse();
      const handler = getRouteHandler(context.router, "/realtime");

      await handler({ query: { city: "深圳" } }, response);

      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(response.body.success, true);
      assert.strictEqual(response.body.data.realtime.city, "深圳");
      assert.strictEqual(response.body.data.realtime.temperature, "24");
      assert.strictEqual(response.body.data.realtime.weather, "晴");
      assert.deepStrictEqual(context.requests, [
        `https://vmy.test/weather?city=${encodeURIComponent("深圳")}`,
        `https://suyan.test/weather?city=${encodeURIComponent("深圳")}`,
      ]);
    } finally {
      if (context) {
        context.restore();
      }
      for (const [name, value] of savedCredentials) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });
});
