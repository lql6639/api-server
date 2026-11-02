"use strict";

const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert");

const origLogger = {};
const logger = require("../utils/logger");
["info", "warn", "error", "debug"].forEach((m) => {
  origLogger[m] = logger[m];
  logger[m] = () => {};
});

const origSendError = require("../utils/errorHandler").sendError;
require("../utils/errorHandler").sendError = (res, code) => {
  res.statusCode = code;
  res._body = { code };
  res.send(res._body);
};

const rateLimitStore = require("../libs/rateLimitStore");

let RateLimiter;

before(() => {
  rateLimitStore.init("memory");
  RateLimiter = require("../utils/rateLimiter");
});

beforeEach(() => {
  const store = rateLimitStore.getStore();
  if (store && typeof store.destroy === "function") {
    store.destroy();
  }
});

after(() => {
  Object.keys(origLogger).forEach((m) => {
    logger[m] = origLogger[m];
  });
  require("../utils/errorHandler").sendError = origSendError;
});

function createMockReq(overrides = {}) {
  const base = {
    ip: "127.0.0.1",
    connection: { remoteAddress: "127.0.0.1" },
    path: "/v1/test",
    get: (header) => {
      if (header === "X-Forwarded-For") return overrides.forwardedFor;
      return undefined;
    },
  };
  return Object.assign(base, overrides);
}

function createMockRes() {
  const res = {
    statusCode: 200,
    _body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this._body = body;
      return this;
    },
    send(body) {
      this._body = body;
      return this;
    },
    end() {
      return this;
    },
  };
  return res;
}

function invokeMiddleware(middleware, req, res) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const origJson = res.json.bind(res);
    res.json = (body) => {
      origJson(body);
      done();
    };
    const origSend = res.send.bind(res);
    res.send = (body) => {
      origSend(body);
      done();
    };

    middleware(req, res, done);
  });
}

describe("RateLimiter middleware", () => {
  it("should call next when under rate limit", async () => {
    const limiter = new RateLimiter({
      enabled: true,
      timeWindow: 60,
      maxRequests: 100,
    });
    const middleware = limiter.middleware();
    const req = createMockReq();
    const res = createMockRes();

    await invokeMiddleware(middleware, req, res);
    assert.strictEqual(res.statusCode, 200);
  });

  it("should return 429 when rate limit exceeded", async () => {
    const limiter = new RateLimiter({
      enabled: true,
      timeWindow: 60,
      maxRequests: 1,
    });
    const middleware = limiter.middleware();

    const req1 = createMockReq({ ip: "10.0.0.1" });
    const res1 = createMockRes();
    await invokeMiddleware(middleware, req1, res1);
    assert.strictEqual(res1.statusCode, 200);

    const req2 = createMockReq({ ip: "10.0.0.1" });
    const res2 = createMockRes();
    await invokeMiddleware(middleware, req2, res2);
    assert.strictEqual(res2.statusCode, 429);
  });

  it("should call next when rate limiter is disabled", async () => {
    const limiter = new RateLimiter({
      enabled: false,
      timeWindow: 60,
      maxRequests: 1,
    });
    const middleware = limiter.middleware();
    const req = createMockReq();
    const res = createMockRes();

    let called = false;
    middleware(req, res, () => {
      called = true;
    });
    assert.strictEqual(called, true);
    assert.strictEqual(res.statusCode, 200);
  });

  it("should use local fallback when store throws error", async () => {
    const origCheck = rateLimitStore.getStore().check;
    rateLimitStore.getStore().check = () => {
      throw new Error("store error");
    };
    try {
      const limiter = new RateLimiter({
        enabled: true,
        timeWindow: 60,
        maxRequests: 1,
      });
      const middleware = limiter.middleware();
      const req = createMockReq({ ip: "198.51.100.40" });
      const firstResponse = createMockRes();
      const secondResponse = createMockRes();

      await invokeMiddleware(middleware, req, firstResponse);
      await invokeMiddleware(middleware, req, secondResponse);
      assert.strictEqual(firstResponse.statusCode, 200);
      assert.strictEqual(secondResponse.statusCode, 429);
    } finally {
      rateLimitStore.getStore().check = origCheck;
    }
  });

  it("should use local fallback when store returns rejected promise", async () => {
    const origCheck = rateLimitStore.getStore().check;
    rateLimitStore.getStore().check = () =>
      Promise.reject(new Error("store reject"));
    try {
      const limiter = new RateLimiter({
        enabled: true,
        timeWindow: 60,
        maxRequests: 1,
      });
      const middleware = limiter.middleware();
      const req = createMockReq({ ip: "198.51.100.41" });
      const response = createMockRes();

      await invokeMiddleware(middleware, req, response);
      assert.strictEqual(response.statusCode, 200);
    } finally {
      rateLimitStore.getStore().check = origCheck;
    }
  });
});

describe("RateLimiter getClientIP", () => {
  it("should use req.ip instead of X-Forwarded-For header", () => {
    const limiter = new RateLimiter({ ipHeader: "X-Forwarded-For" });
    const req = createMockReq({ forwardedFor: "10.0.0.5", ip: "198.51.100.5" });
    assert.strictEqual(limiter.getClientIP(req), "198.51.100.5");
  });

  it("should ignore a forged X-Forwarded-For chain", () => {
    const limiter = new RateLimiter({ ipHeader: "X-Forwarded-For" });
    const req = createMockReq({
      forwardedFor: "10.0.0.5, 192.168.1.1",
      ip: "198.51.100.6",
    });
    assert.strictEqual(limiter.getClientIP(req), "198.51.100.6");
  });

  it("should not parse whitespace-separated forwarding headers", () => {
    const limiter = new RateLimiter({ ipHeader: "X-Forwarded-For" });
    const req = createMockReq({
      forwardedFor: "  10.0.0.5 , 192.168.1.1  ",
      ip: "198.51.100.7",
    });
    assert.strictEqual(limiter.getClientIP(req), "198.51.100.7");
  });

  it("should fall back to req.ip when X-Forwarded-For is empty", () => {
    const limiter = new RateLimiter({ ipHeader: "X-Forwarded-For" });
    const req = createMockReq({ forwardedFor: "", ip: "192.168.0.1" });
    assert.strictEqual(limiter.getClientIP(req), "192.168.0.1");
  });

  it("should fall back to req.ip when X-Forwarded-For is undefined", () => {
    const limiter = new RateLimiter({ ipHeader: "X-Forwarded-For" });
    const req = createMockReq({ forwardedFor: undefined, ip: "10.1.1.1" });
    assert.strictEqual(limiter.getClientIP(req), "10.1.1.1");
  });

  it("should fall back to a stable placeholder when req.ip is not set", () => {
    const limiter = new RateLimiter({ ipHeader: "X-Forwarded-For" });
    const req = createMockReq({ forwardedFor: undefined, ip: undefined });
    req.connection = { remoteAddress: "::1" };
    assert.strictEqual(limiter.getClientIP(req), "0.0.0.0");
  });

  it("should return 0.0.0.0 when no IP info available", () => {
    const limiter = new RateLimiter({ ipHeader: "X-Forwarded-For" });
    const req = {
      get: () => undefined,
      ip: undefined,
      connection: { remoteAddress: undefined },
    };
    assert.strictEqual(limiter.getClientIP(req), "0.0.0.0");
  });

  it("should ignore custom forwarding header configuration", () => {
    const limiter = new RateLimiter({ ipHeader: "X-Real-IP" });
    const req = createMockReq();
    req.get = (header) => {
      if (header === "X-Real-IP") return "5.5.5.5";
      return undefined;
    };
    assert.strictEqual(limiter.getClientIP(req), "127.0.0.1");
  });

  it("should skip ipHeader check when ipHeader is falsy", () => {
    const limiter = new RateLimiter({ ipHeader: "" });
    const req = createMockReq({ forwardedFor: "evil.com", ip: "127.0.0.1" });
    assert.strictEqual(limiter.getClientIP(req), "127.0.0.1");
  });

  it("should use req.ip regardless of legacy ipHeader configuration", () => {
    const limiter = new RateLimiter({});
    const req = createMockReq({ forwardedFor: "1.2.3.4", ip: "198.51.100.8" });
    assert.strictEqual(limiter.getClientIP(req), "198.51.100.8");
  });
});

describe("RateLimiter check", () => {
  it("should return allowed true when disabled", async () => {
    const limiter = new RateLimiter({ enabled: false });
    const result = await limiter.check("127.0.0.1");
    assert.strictEqual(result.allowed, true);
  });

  it("should delegate to store when enabled", async () => {
    const limiter = new RateLimiter({
      enabled: true,
      timeWindow: 60,
      maxRequests: 100,
    });
    const result = await limiter.check("test_ip_delegate");
    assert.strictEqual(result.allowed, true);
    assert.ok(typeof result.remaining === "number");
    assert.ok(typeof result.reset === "number");
  });

  it("should block after maxRequests reached", async () => {
    const limiter = new RateLimiter({
      enabled: true,
      timeWindow: 60,
      maxRequests: 2,
    });
    await limiter.check("block_ip2");
    await limiter.check("block_ip2");
    const result = await limiter.check("block_ip2");
    assert.strictEqual(result.allowed, false);
  });
});

describe("RateLimiter constructor", () => {
  it("should default timeWindow to 60", () => {
    const limiter = new RateLimiter({ enabled: true });
    assert.strictEqual(limiter.timeWindow, 60);
  });

  it("should default maxRequests to 100", () => {
    const limiter = new RateLimiter({ enabled: true });
    assert.strictEqual(limiter.maxRequests, 100);
  });

  it("should not expose a configurable client IP header", () => {
    const limiter = new RateLimiter({ enabled: true });
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(limiter, "ipHeader"),
      false,
    );
  });

  it("should default enabled to true when not specified", () => {
    const limiter = new RateLimiter({});
    assert.strictEqual(limiter.enabled, true);
  });
});

describe("RateLimiter destroy", () => {
  it("should call store.destroy", () => {
    const limiter = new RateLimiter({ enabled: true });
    const store = rateLimitStore.getStore();
    let destroyed = false;
    const origDestroy = store.destroy;
    store.destroy = () => {
      destroyed = true;
    };
    limiter.destroy();
    assert.strictEqual(destroyed, true);
    store.destroy = origDestroy;
  });

  it("should not throw when store has no destroy method", () => {
    const limiter = new RateLimiter({ enabled: true });
    const store = rateLimitStore.getStore();
    const origDestroy = store.destroy;
    delete store.destroy;
    assert.doesNotThrow(() => limiter.destroy());
    store.destroy = origDestroy;
  });
});

describe("RateLimiter middleware error response", () => {
  it("should return JSON response for API paths when rate limited", async () => {
    const limiter = new RateLimiter({
      enabled: true,
      timeWindow: 60,
      maxRequests: 1,
    });
    const middleware = limiter.middleware();

    const req = createMockReq({ ip: "10.0.0.99", path: "/v1/users" });
    const res = createMockRes();
    await invokeMiddleware(middleware, req, res);

    const req2 = createMockReq({ ip: "10.0.0.99", path: "/v1/users" });
    const res2 = createMockRes();
    await invokeMiddleware(middleware, req2, res2);

    assert.strictEqual(res2.statusCode, 429);
    assert.ok(res2._body);
    assert.strictEqual(res2._body.status, "error");
    assert.ok(typeof res2._body.time === "number");
  });

  it("should call sendError for non-API paths when rate limited", async () => {
    const limiter = new RateLimiter({
      enabled: true,
      timeWindow: 60,
      maxRequests: 1,
    });
    const middleware = limiter.middleware();

    const req = createMockReq({ ip: "10.0.0.100", path: "/other" });
    const res = createMockRes();
    await invokeMiddleware(middleware, req, res);

    const req2 = createMockReq({ ip: "10.0.0.100", path: "/other" });
    const res2 = createMockRes();
    await invokeMiddleware(middleware, req2, res2);

    assert.strictEqual(res2.statusCode, 429);
    assert.strictEqual(res2._body.code, 429);
  });
});
