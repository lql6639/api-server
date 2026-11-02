"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");

let store;

before(async () => {
  const cacheStore = require("../libs/cacheStore");
  store = cacheStore.init("memory");
  await store.flush();
});

beforeEach(async () => {
  await store.flush();
});

describe("MemoryStore get", () => {
  it("should return null for non-existent key", async () => {
    const result = await store.get("missing");
    assert.strictEqual(result, null);
  });

  it("should return stored string value", async () => {
    await store.set("k1", "hello", 60);
    const result = await store.get("k1");
    assert.strictEqual(result, "hello");
  });

  it("should return stored number value", async () => {
    await store.set("k2", 42, 60);
    const result = await store.get("k2");
    assert.strictEqual(result, 42);
  });

  it("should return stored boolean value", async () => {
    await store.set("k3", false, 60);
    const result = await store.get("k3");
    assert.strictEqual(result, false);
  });

  it("should return stored object value", async () => {
    const obj = { a: 1, b: "test", c: [1, 2, 3] };
    await store.set("k4", obj, 60);
    const result = await store.get("k4");
    assert.deepStrictEqual(result, obj);
  });

  it("should return stored null value", async () => {
    await store.set("k5", null, 60);
    const result = await store.get("k5");
    assert.strictEqual(result, null);
  });

  it("should return stored zero value", async () => {
    await store.set("k6", 0, 60);
    const result = await store.get("k6");
    assert.strictEqual(result, 0);
  });

  it("should return stored empty string value", async () => {
    await store.set("k7", "", 60);
    const result = await store.get("k7");
    assert.strictEqual(result, "");
  });

  it("should return null after TTL expires", async () => {
    await store.set("expire_me", "value", 0.001);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await store.get("expire_me");
    assert.strictEqual(result, null);
  });

  it("should persist value when TTL is 0", async () => {
    await store.set("no_expire", "forever", 0);
    const result = await store.get("no_expire");
    assert.strictEqual(result, "forever");
  });

  it("should persist value when TTL is negative", async () => {
    await store.set("neg_expire", "still", -1);
    const result = await store.get("neg_expire");
    assert.strictEqual(result, "still");
  });

  it("should lazily clean expired key on get and return null", async () => {
    await store.set("lazy_expire", "temp", 0.001);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await store.get("lazy_expire");
    assert.strictEqual(result, null);
    const result2 = await store.get("lazy_expire");
    assert.strictEqual(result2, null);
  });
});

describe("MemoryStore set", () => {
  it("should overwrite existing key with new value", async () => {
    await store.set("overwrite", "old", 60);
    await store.set("overwrite", "new", 60);
    const result = await store.get("overwrite");
    assert.strictEqual(result, "new");
  });

  it("should handle TTL as string number", async () => {
    await store.set("str_ttl", "val", "30");
    const result = await store.get("str_ttl");
    assert.strictEqual(result, "val");
  });
});

describe("MemoryStore del", () => {
  it("should remove existing key", async () => {
    await store.set("del_me", "value", 60);
    await store.del("del_me");
    const result = await store.get("del_me");
    assert.strictEqual(result, null);
  });

  it("should not throw when deleting non-existent key", async () => {
    await assert.doesNotReject(() => store.del("no_such_key"));
  });

  it("should delete only when the stored value matches", async () => {
    await store.set("lock", "owner-a", 60);
    assert.strictEqual(await store.delIfValue("lock", "owner-b"), false);
    assert.strictEqual(await store.has("lock"), true);
    assert.strictEqual(await store.delIfValue("lock", "owner-a"), true);
    assert.strictEqual(await store.has("lock"), false);
  });

  it("should not delete a lock acquired by a new owner", async () => {
    await store.setNX("reacquired_lock", "owner-a", 0.001);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(
      await store.setNX("reacquired_lock", "owner-b", 60),
      true,
    );

    assert.strictEqual(
      await store.delIfValue("reacquired_lock", "owner-a"),
      false,
    );
    assert.strictEqual(await store.get("reacquired_lock"), "owner-b");
  });
});

describe("MemoryStore has", () => {
  it("should return false for non-existent key", async () => {
    const result = await store.has("ghost");
    assert.strictEqual(result, false);
  });

  it("should return true for existing key", async () => {
    await store.set("exists", "yes", 60);
    const result = await store.has("exists");
    assert.strictEqual(result, true);
  });

  it("should lazily clean expired key and return false", async () => {
    await store.set("has_expire", "temp", 0.001);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await store.has("has_expire");
    assert.strictEqual(result, false);
  });

  it("should return true for non-expiring key", async () => {
    await store.set("has_no_expire", "forever", 0);
    const result = await store.has("has_no_expire");
    assert.strictEqual(result, true);
  });
});

describe("MemoryStore setNX", () => {
  it("should return true and set value for new key", async () => {
    const result = await store.setNX("nx_new", "value", 60);
    assert.strictEqual(result, true);
    const val = await store.get("nx_new");
    assert.strictEqual(val, "value");
  });

  it("should return false when key already exists", async () => {
    await store.set("nx_existing", "old", 60);
    const result = await store.setNX("nx_existing", "new", 60);
    assert.strictEqual(result, false);
    const val = await store.get("nx_existing");
    assert.strictEqual(val, "old");
  });

  it("should return true when key expired and lazily cleaned", async () => {
    await store.set("nx_expired", "old", 0.001);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await store.setNX("nx_expired", "new", 60);
    assert.strictEqual(result, true);
    const val = await store.get("nx_expired");
    assert.strictEqual(val, "new");
  });

  it("should allow exactly one concurrent lock acquisition", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        store.setNX("atomic_lock", `owner-${index}`, 60),
      ),
    );

    assert.strictEqual(attempts.filter(Boolean).length, 1);
    assert.match(await store.get("atomic_lock"), /^owner-\d+$/);
  });
});

describe("MemoryStore flush", () => {
  it("should remove all keys", async () => {
    await store.set("f1", "a", 60);
    await store.set("f2", "b", 60);
    await store.flush();
    assert.strictEqual(await store.get("f1"), null);
    assert.strictEqual(await store.get("f2"), null);
  });
});

describe("cacheStore singleton", () => {
  it("should return same instance from init and getStore", () => {
    const { getStore } = require("../libs/cacheStore");
    const s = getStore();
    assert.strictEqual(s, store);
  });

  it("should throw when getStore called before init", () => {
    delete require.cache[require.resolve("../libs/cacheStore")];
    const fresh = require("../libs/cacheStore");
    assert.throws(() => fresh.getStore(), /CacheStore .*/);
    fresh.init("memory");
  });
});
