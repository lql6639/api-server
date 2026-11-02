"use strict";

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert");

let store;

before(async () => {
  const rateLimitStore = require("../libs/rateLimitStore");
  store = rateLimitStore.init("memory");
});

beforeEach(() => {
  store.destroy();
});

describe("MemoryRateLimitStore check", () => {
  it("should allow first request and set remaining correctly", async () => {
    const result = await store.check("ip1", 60, 100);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.remaining, 99);
  });

  it("should allow requests within window under max", async () => {
    for (let i = 0; i < 4; i++) {
      const result = await store.check("ip2", 60, 5);
      assert.strictEqual(result.allowed, true);
      assert.strictEqual(result.remaining, 5 - i - 1);
    }
  });

  it("should reject requests when count equals max", async () => {
    for (let i = 0; i < 5; i++) {
      await store.check("ip3", 60, 5);
    }
    const result = await store.check("ip3", 60, 5);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.remaining, 0);
  });

  it("should reject requests when count exceeds max", async () => {
    for (let i = 0; i < 5; i++) {
      await store.check("ip4", 60, 5);
    }
    const r1 = await store.check("ip4", 60, 5);
    assert.strictEqual(r1.allowed, false);
    const r2 = await store.check("ip4", 60, 5);
    assert.strictEqual(r2.allowed, false);
    assert.strictEqual(r2.remaining, 0);
  });

  it("should reset after window expires", async () => {
    for (let i = 0; i < 5; i++) {
      await store.check("ip5", 0.01, 5);
    }
    const blocked = await store.check("ip5", 0.01, 5);
    assert.strictEqual(blocked.allowed, false);

    await new Promise((resolve) => setTimeout(resolve, 30));

    const result = await store.check("ip5", 0.01, 5);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.remaining, 4);
  });

  it("should track different keys independently", async () => {
    await store.check("ipA", 60, 1);
    const result = await store.check("ipA", 60, 1);
    assert.strictEqual(result.allowed, false);

    const otherResult = await store.check("ipB", 60, 1);
    assert.strictEqual(otherResult.allowed, true);
  });

  it("should calculate remaining as max - current count within window", async () => {
    const max = 10;
    for (let i = 0; i < 3; i++) {
      const r = await store.check("ip6", 60, max);
      assert.strictEqual(r.remaining, max - i - 1);
    }
  });

  it("should set reset timestamp to approximately now + windowSeconds", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const result = await store.check("ip7", 60, 100);
    assert.ok(result.reset >= nowSeconds + 59);
    assert.ok(result.reset <= nowSeconds + 61);
  });

  it("should allow single request when max is 1", async () => {
    const r1 = await store.check("ip8", 60, 1);
    assert.strictEqual(r1.allowed, true);
    const r2 = await store.check("ip8", 60, 1);
    assert.strictEqual(r2.allowed, false);
  });

  it("should return remaining of 0 when blocked", async () => {
    await store.check("ip9", 60, 1);
    const result = await store.check("ip9", 60, 1);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.remaining, 0);
  });

  it("should clean old timestamps and not count them against limit", async () => {
    const now = Date.now();
    store.records.set("ip10", [now - 100000, now - 90000, now - 80000]);
    const result = await store.check("ip10", 1, 3);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.remaining, 2);
  });

  it("should keep recent timestamps after cleanup", async () => {
    const now = Date.now();
    store.records.set("ip11", [now - 500, now - 200]);
    const result = await store.check("ip11", 1, 3);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.remaining, 0);
  });
});

describe("rateLimitStore singleton", () => {
  it("should return same instance from getStore", () => {
    const { getStore } = require("../libs/rateLimitStore");
    assert.strictEqual(getStore(), store);
  });

  it("should throw when getStore called before init", () => {
    delete require.cache[require.resolve("../libs/rateLimitStore")];
    const fresh = require("../libs/rateLimitStore");
    assert.throws(() => fresh.getStore(), /RateLimitStore .*/);
    fresh.init("memory");
  });
});
