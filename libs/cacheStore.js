class MemoryStore {
  constructor() {
    this.store = new Map();
    this.cleanupTimer = setInterval(() => this._deleteExpired(), 60000);
    this.cleanupTimer.unref();
  }

  _now() {
    return Date.now();
  }

  _deleteExpired() {
    const now = this._now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt > 0 && now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  _ensureCleanupTimer() {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this._deleteExpired(), 60000);
    this.cleanupTimer.unref();
  }

  async get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt > 0 && this._now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key, value, ttlSeconds) {
    this._ensureCleanupTimer();
    const ttl = Number(ttlSeconds);
    this.store.set(key, {
      value,
      expiresAt: ttl > 0 ? this._now() + ttl * 1000 : 0,
    });
  }

  async del(key) {
    this.store.delete(key);
  }

  async delIfValue(key, value) {
    const entry = this.store.get(key);
    if (!entry || entry.value !== value) return false;
    this.store.delete(key);
    return true;
  }

  async has(key) {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (entry.expiresAt > 0 && this._now() > entry.expiresAt) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  async setNX(key, value, ttlSeconds) {
    this._ensureCleanupTimer();
    const entry = this.store.get(key);
    if (entry && (entry.expiresAt === 0 || this._now() <= entry.expiresAt))
      return false;
    if (entry) this.store.delete(key);
    const ttl = Number(ttlSeconds);
    this.store.set(key, {
      value,
      expiresAt: ttl > 0 ? this._now() + ttl * 1000 : 0,
    });
    return true;
  }

  async flush() {
    this.store.clear();
  }

  destroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.store.clear();
  }
}

class RedisStore {
  constructor(redis, prefix) {
    this.redis = redis;
    this.prefix = prefix;
  }

  _key(key) {
    return this.prefix + key;
  }

  async get(key) {
    const raw = await this.redis.get(this._key(key));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  async set(key, value, ttlSeconds) {
    const k = this._key(key);
    const serialized = JSON.stringify(value);
    const ttl = Number(ttlSeconds);
    if (ttl > 0) {
      await this.redis.set(k, serialized, "EX", ttl);
    } else {
      await this.redis.set(k, serialized);
    }
  }

  async del(key) {
    await this.redis.del(this._key(key));
  }

  async delIfValue(key, value) {
    const result = await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      this._key(key),
      JSON.stringify(value),
    );
    return result === 1;
  }

  async has(key) {
    const exists = await this.redis.exists(this._key(key));
    return exists === 1;
  }

  async setNX(key, value, ttlSeconds) {
    const k = this._key(key);
    const serialized = JSON.stringify(value);
    const ttl = Number(ttlSeconds);
    let result;
    if (ttl > 0) {
      result = await this.redis.set(k, serialized, "EX", ttl, "NX");
    } else {
      result = await this.redis.set(k, serialized, "NX");
    }
    return result === "OK";
  }

  async flush() {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        this.prefix + "*",
        "COUNT",
        100,
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } while (cursor !== "0");
  }

  destroy() {}
}

let storeInstance = null;

function init(mode, redisClient, prefix) {
  if (storeInstance) return storeInstance;
  storeInstance =
    mode === "redis"
      ? new RedisStore(redisClient, prefix || "")
      : new MemoryStore();
  return storeInstance;
}

function getStore() {
  if (!storeInstance) throw new Error("CacheStore 未初始化");
  return storeInstance;
}

module.exports = { init, getStore };
