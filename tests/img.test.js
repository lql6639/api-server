"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const CACHE_STORE_PATH = require.resolve("../libs/cacheStore");
const CONFIG_PATH = require.resolve("../v1/img/config.json");
const HTTP_CLIENT_PATH = require.resolve("../utils/httpClient");
const IMG_PATH = require.resolve("../v1/img");
const LOGGER_PATH = require.resolve("../utils/logger");
const IMG_MODULE_PATHS = [
  CACHE_STORE_PATH,
  CONFIG_PATH,
  HTTP_CLIENT_PATH,
  IMG_PATH,
  LOGGER_PATH,
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

function createImageContext(options = {}) {
  const snapshot = snapshotModules(IMG_MODULE_PATHS);
  const cacheValues = new Map();
  const locks = new Map();
  const listRequests = [];
  const imageRequests = [];
  const config = {
    url: "https://images.test/base/",
    cache_ttl: 60,
    upstream: {
      horizontal: "https://upstream.test/horizontal",
      vertical: "https://upstream.test/vertical",
    },
    timeout_ms: 1000,
    max_image_bytes: 1024,
    ...options.config,
  };
  const cache = {
    async get(key) {
      return cacheValues.has(key) ? cacheValues.get(key) : null;
    },
    async set(key, value) {
      cacheValues.set(key, value);
    },
    async setNX(key, value) {
      if (locks.has(key)) {
        return false;
      }
      locks.set(key, value);
      return true;
    },
    async delIfValue(key, value) {
      if (locks.get(key) !== value) {
        return false;
      }
      locks.delete(key);
      return true;
    },
  };

  class MockHttpClient {
    constructor() {
      this.axios = {
        get: async (url, requestOptions) => {
          imageRequests.push({ url, requestOptions });
          return options.imageResponse;
        },
      };
    }

    async get(url, query, requestOptions) {
      listRequests.push({ url, query, requestOptions });
      if (typeof options.listResponse === "function") {
        return options.listResponse(url, query, requestOptions);
      }
      return (
        options.listResponse || {
          items: [{ name: "fresh", path: "/fresh.jpg" }],
        }
      );
    }
  }

  delete require.cache[IMG_PATH];
  setCachedModule(CACHE_STORE_PATH, { getStore: () => cache });
  setCachedModule(CONFIG_PATH, config);
  setCachedModule(HTTP_CLIENT_PATH, MockHttpClient);
  setCachedModule(LOGGER_PATH, {
    debug() {},
    error() {},
    info() {},
    warn() {},
  });

  try {
    const router = require(IMG_PATH);
    return {
      cacheValues,
      imageRequests,
      listRequests,
      router,
      async settle() {
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
      },
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
    body: null,
    headers: {},
    statusCode: 200,
    end(body) {
      this.body = body;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    redirect(statusCode, location) {
      this.statusCode = statusCode;
      this.location = location;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    type(contentType) {
      this.headers["Content-Type"] = contentType;
      return this;
    },
  };
}

function createCloseableResponse() {
  const response = createResponse();
  const listeners = new Map();
  response.writableEnded = false;
  response.once = (event, listener) => {
    listeners.set(event, listener);
    return response;
  };
  response.emitClose = () => {
    const listener = listeners.get("close");
    if (listener) {
      listener();
    }
  };
  return response;
}

function createUpstreamStream() {
  return {
    destroyed: false,
    destroyCalls: 0,
    listeners: new Map(),
    destroy(error) {
      this.destroyCalls++;
      this.destroyError = error;
      this.destroyed = true;
    },
    on(event, listener) {
      this.listeners.set(event, listener);
      return this;
    },
    pipe(destination) {
      this.destination = destination;
      return destination;
    },
  };
}

describe("image cache and response validation", () => {
  it("should rebuild cached URLs from validated item paths", async () => {
    const context = createImageContext();
    try {
      await context.settle();
      const listRequestCount = context.listRequests.length;
      context.cacheValues.set("img:horizontal", {
        baseUrl: "https://attacker.test",
        fetchedAt: Date.now(),
        items: [{ name: "cached", path: "cached.jpg" }],
        urls: ["https://attacker.test/image.jpg"],
      });
      const response = createResponse();
      const handler = getRouteHandler(context.router, "/h");

      await handler({ headers: {}, query: { type: "text" } }, response);

      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(response.body, "https://images.test/base/cached.jpg");
      assert.strictEqual(context.listRequests.length, listRequestCount);
    } finally {
      context.restore();
    }
  });

  it("should refresh instead of serving a malformed cached image list", async () => {
    const context = createImageContext();
    try {
      await context.settle();
      const listRequestCount = context.listRequests.length;
      context.cacheValues.set("img:horizontal", {
        fetchedAt: "not-a-timestamp",
        items: { name: "stale", path: "/stale.jpg" },
        urls: ["https://attacker.test/stale.jpg"],
      });
      const response = createResponse();
      const handler = getRouteHandler(context.router, "/h");

      await handler({ headers: {}, query: { type: "json" } }, response);

      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(response.body.status, "success");
      assert.deepStrictEqual(response.body.data, {
        id: "1",
        fullUrl: "https://images.test/base/fresh.jpg",
        name: "fresh",
        path: "/fresh.jpg",
        url: "https://images.test/base",
      });
      assert.strictEqual(context.listRequests.length, listRequestCount + 1);
    } finally {
      context.restore();
    }
  });

  it("should reject a non-image upstream response before streaming it", async () => {
    let destroyed = false;
    const context = createImageContext({
      imageResponse: {
        data: {
          destroy() {
            destroyed = true;
          },
        },
        headers: {
          "content-length": "32",
          "content-type": "text/html; charset=utf-8",
        },
        status: 200,
      },
    });
    try {
      await context.settle();
      context.cacheValues.set("img:horizontal", {
        fetchedAt: Date.now(),
        items: [{ name: "cached", path: "/cached.jpg" }],
      });
      const response = createResponse();
      const handler = getRouteHandler(context.router, "/h");

      await handler({ headers: {}, query: { type: "img" } }, response);

      assert.strictEqual(response.statusCode, 502);
      assert.strictEqual(response.body.message, "图片上游返回了非图片内容");
      assert.strictEqual(destroyed, true);
      assert.strictEqual(context.imageRequests.length, 1);
      assert.strictEqual(
        context.imageRequests[0].requestOptions.maxContentLength,
        1024,
      );
      assert.strictEqual(
        context.imageRequests[0].requestOptions.maxBodyLength,
        1024,
      );
    } finally {
      context.restore();
    }
  });

  it("should destroy the upstream stream when the client closes before the response ends", async () => {
    const upstreamStream = createUpstreamStream();
    const context = createImageContext({
      imageResponse: {
        data: upstreamStream,
        headers: {
          "content-length": "32",
          "content-type": "image/png",
        },
        status: 200,
      },
    });
    try {
      await context.settle();
      context.cacheValues.set("img:horizontal", {
        fetchedAt: Date.now(),
        items: [{ name: "cached", path: "/cached.png" }],
      });
      const response = createCloseableResponse();
      const handler = getRouteHandler(context.router, "/h");

      await handler({ headers: {}, query: { type: "img" } }, response);
      response.emitClose();

      assert.strictEqual(upstreamStream.destination, response);
      assert.strictEqual(upstreamStream.destroyed, true);
      assert.strictEqual(upstreamStream.destroyCalls, 1);
    } finally {
      context.restore();
    }
  });
});
