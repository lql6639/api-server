"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { describe, it } = require("node:test");

const APP_PATH = require.resolve("../core/app");
const STUBS = new Map([
  [
    require.resolve("../utils/configLoader"),
    {
      apiDir: "v1",
      log: {},
      markdown: {},
      rateLimit: { enabled: true },
      redis: { enabled: false },
      staticDir: "public",
    },
  ],
  [
    require.resolve("../utils/logger"),
    {
      debug() {},
      error() {},
      info() {},
      init() {},
      middleware() {
        return (req, res, next) => next();
      },
      warn() {},
    },
  ],
  [require.resolve("../utils/corsHandler"), (req, res, next) => next()],
  [require.resolve("../utils/urlDecoder"), (req, res, next) => next()],
  [
    require.resolve("../utils/rateLimiter"),
    class RateLimiter {
      destroy() {}

      middleware() {
        return (req, res, next) => next();
      }
    },
  ],
  [require.resolve("../core/apiLoader"), () => {}],
  [
    require.resolve("../utils/errorHandler"),
    {
      errorHandlerMiddleware(error, req, res, next) {
        next(error);
      },
    },
  ],
  [require.resolve("../utils/staticServer"), { setupStaticRoutes() {} }],
  [
    require.resolve("../utils/markdownRenderer"),
    { MarkdownRenderer: class MarkdownRenderer {} },
  ],
  [require.resolve("../libs/redisClient"), {}],
  [require.resolve("../libs/cacheStore"), { init() {} }],
  [require.resolve("../libs/rateLimitStore"), { init() {} }],
]);

function setCachedModule(modulePath, moduleExports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: moduleExports,
  };
}

function loadCreateApp() {
  const modulePaths = [APP_PATH, ...STUBS.keys()];
  const snapshot = new Map(
    modulePaths.map((modulePath) => [modulePath, require.cache[modulePath]]),
  );
  delete require.cache[APP_PATH];
  for (const [modulePath, moduleExports] of STUBS) {
    setCachedModule(modulePath, moduleExports);
  }

  return {
    createApp: require(APP_PATH),
    restore() {
      for (const [modulePath, cachedModule] of snapshot) {
        delete require.cache[modulePath];
        if (cachedModule) {
          require.cache[modulePath] = cachedModule;
        }
      }
    },
  };
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function requestClientIp(server, forwardedFor) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/client-ip",
        headers: forwardedFor ? { "X-Forwarded-For": forwardedFor } : {},
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once("error", reject);
  });
}

describe("app trust proxy", () => {
  it("should trust only loopback proxies and ignore forged X-Forwarded-For prefixes", async () => {
    const loaded = loadCreateApp();
    let server;
    try {
      const { app } = await loaded.createApp();
      const trust = app.get("trust proxy fn");
      assert.strictEqual(app.get("trust proxy"), "loopback");
      assert.strictEqual(trust("127.0.0.1", 0), true);
      assert.strictEqual(trust("::1", 0), true);
      assert.strictEqual(trust("192.0.2.10", 0), false);

      app.get("/client-ip", (req, res) => {
        res.json({ ip: req.ip, ips: req.ips });
      });
      server = await listen(app);

      assert.deepStrictEqual(await requestClientIp(server), {
        ip: "127.0.0.1",
        ips: [],
      });
      assert.deepStrictEqual(await requestClientIp(server, "198.51.100.20"), {
        ip: "198.51.100.20",
        ips: ["198.51.100.20"],
      });
      assert.deepStrictEqual(
        await requestClientIp(server, "203.0.113.9, 198.51.100.20"),
        {
          ip: "198.51.100.20",
          ips: ["198.51.100.20"],
        },
      );
    } finally {
      if (server) {
        await close(server);
      }
      loaded.restore();
    }
  });
});
