"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const path = require("path");

let callLog;
let mockRedisInstance;

class MockRedis {
  constructor(config) {
    this.config = config;
    this.status = "connecting";
    this._eventHandlers = {};
    callLog.push(["constructor", config]);
    mockRedisInstance = this;
  }

  on(event, handler) {
    this._eventHandlers[event] = handler;
  }

  connect() {
    this.status = "ready";
    callLog.push(["connect"]);
    return Promise.resolve();
  }

  quit() {
    callLog.push(["quit"]);
    return Promise.resolve("OK");
  }

  disconnect() {
    callLog.push(["disconnect"]);
  }
}

function resetModule() {
  const modPath = require.resolve("../libs/redisClient");
  delete require.cache[modPath];
  const ioredisPath = require.resolve("ioredis");
  delete require.cache[ioredisPath];
}

function mockIoredis() {
  const ioredisPath = require.resolve("ioredis");
  require.cache[ioredisPath] = {
    id: ioredisPath,
    filename: ioredisPath,
    loaded: true,
    exports: MockRedis,
  };
}

beforeEach(() => {
  delete process.env.REDIS_PASSWORD;
  callLog = [];
  mockRedisInstance = null;
  resetModule();
  mockIoredis();
});

after(() => {
  delete process.env.REDIS_PASSWORD;
  resetModule();
});

describe("redisClient init", () => {
  it("should create Redis client with config", () => {
    const redisClient = require("../libs/redisClient");
    const config = { host: "127.0.0.1", port: 6379, db: 2 };
    const client = redisClient.init(config);

    assert.ok(client instanceof MockRedis);
    assert.ok(callLog.length >= 1);
    const ctorArgs = callLog[0][1];
    assert.strictEqual(ctorArgs.host, "127.0.0.1");
    assert.strictEqual(ctorArgs.port, 6379);
    assert.strictEqual(ctorArgs.db, 2);
    assert.strictEqual(ctorArgs.lazyConnect, true);
  });

  it("should use db 0 when not specified", () => {
    const redisClient = require("../libs/redisClient");
    redisClient.init({ host: "127.0.0.1", port: 6379 });
    const ctorArgs = callLog[0][1];
    assert.strictEqual(ctorArgs.db, 0);
  });

  it("should set retryStrategy", () => {
    const redisClient = require("../libs/redisClient");
    redisClient.init({ host: "127.0.0.1", port: 6379 });
    const ctorArgs = callLog[0][1];
    const strategy = ctorArgs.retryStrategy;
    assert.strictEqual(typeof strategy, "function");

    assert.strictEqual(strategy(1), 200);
    assert.strictEqual(strategy(3), 600);
    assert.strictEqual(strategy(4), null);
  });

  it("should prefer REDIS_PASSWORD over config password", () => {
    process.env.REDIS_PASSWORD = "environment-secret";
    const redisClient = require("../libs/redisClient");
    redisClient.init({
      host: "127.0.0.1",
      port: 6379,
      password: "config-secret",
    });
    assert.strictEqual(callLog[0][1].password, "environment-secret");
  });

  it("should use config password when REDIS_PASSWORD is empty", () => {
    process.env.REDIS_PASSWORD = "";
    const redisClient = require("../libs/redisClient");
    redisClient.init({
      host: "127.0.0.1",
      port: 6379,
      password: "config-secret",
    });
    assert.strictEqual(callLog[0][1].password, "config-secret");
  });

  it("should return same client on second init call", () => {
    const redisClient = require("../libs/redisClient");
    const client1 = redisClient.init({ host: "127.0.0.1", port: 6379 });
    const client2 = redisClient.init({ host: "other", port: 9999 });
    assert.strictEqual(client1, client2);
    assert.strictEqual(callLog.length, 1);
  });
});

describe("redisClient connect", () => {
  it("should call client.connect and return client", async () => {
    const redisClient = require("../libs/redisClient");
    redisClient.init({ host: "127.0.0.1", port: 6379 });
    const client = await redisClient.connect();
    assert.strictEqual(client.status, "ready");
    assert.ok(callLog.some((e) => e[0] === "connect"));
  });

  it("should throw when connect called before init", async () => {
    const redisClient = require("../libs/redisClient");
    await assert.rejects(() => redisClient.connect(), /Redis .*/);
  });
});

describe("redisClient getClient", () => {
  it("should return client after init", () => {
    const redisClient = require("../libs/redisClient");
    redisClient.init({ host: "127.0.0.1", port: 6379 });
    const client = redisClient.getClient();
    assert.ok(client instanceof MockRedis);
  });

  it("should return null when not initialized", () => {
    const redisClient = require("../libs/redisClient");
    assert.strictEqual(redisClient.getClient(), null);
  });
});

describe("redisClient isConnected", () => {
  it("should return null when not initialized", () => {
    const redisClient = require("../libs/redisClient");
    assert.strictEqual(redisClient.isConnected(), null);
  });

  it("should return false after init but before connect", () => {
    const redisClient = require("../libs/redisClient");
    redisClient.init({ host: "127.0.0.1", port: 6379 });
    assert.strictEqual(redisClient.isConnected(), false);
  });

  it("should return true after connect when status is ready", async () => {
    const redisClient = require("../libs/redisClient");
    redisClient.init({ host: "127.0.0.1", port: 6379 });
    await redisClient.connect();
    assert.strictEqual(redisClient.isConnected(), true);
  });
});

describe("redisClient destroy", () => {
  it("should call quit and disconnect, set client to null", async () => {
    const redisClient = require("../libs/redisClient");
    redisClient.init({ host: "127.0.0.1", port: 6379 });
    await redisClient.connect();
    await redisClient.destroy();

    assert.strictEqual(redisClient.getClient(), null);
    assert.ok(callLog.some((e) => e[0] === "quit"));
    assert.ok(callLog.some((e) => e[0] === "disconnect"));
  });

  it("should not throw when destroy called without init", async () => {
    const redisClient = require("../libs/redisClient");
    await assert.doesNotReject(() => redisClient.destroy());
  });

  it("should allow re-init after destroy with new config", async () => {
    const redisClient = require("../libs/redisClient");
    redisClient.init({ host: "127.0.0.1", port: 6379 });
    await redisClient.destroy();

    callLog = [];

    const client = redisClient.init({ host: "127.0.0.1", port: 9999 });
    assert.ok(client instanceof MockRedis);
    assert.strictEqual(callLog.length, 1);
    assert.strictEqual(callLog[0][1].port, 9999);
  });
});

describe("redisClient error handling", () => {
  it("should register error event handler", () => {
    const redisClient = require("../libs/redisClient");
    redisClient.init({ host: "127.0.0.1", port: 6379 });
    assert.ok(typeof mockRedisInstance._eventHandlers.error === "function");
  });
});
