class MemoryRateLimitStore {
  constructor() {
    this.records = new Map();
    this.expirations = new Map();
    this.cleanupTimer = null;
    this._ensureCleanupTimer();
  }

  _ensureCleanupTimer() {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this._deleteExpired(), 60000);
    this.cleanupTimer.unref();
  }

  _deleteExpired() {
    const now = Date.now();
    for (const [key, expiresAt] of this.expirations.entries()) {
      if (now > expiresAt) {
        this.records.delete(key);
        this.expirations.delete(key);
      }
    }
  }

  async check(key, windowSeconds, maxRequests) {
    this._ensureCleanupTimer();
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const windowStart = now - windowMs;

    let records = this.records.get(key);
    if (!records) {
      records = [];
      this.records.set(key, records);
    }

    const recent = records.filter((ts) => ts > windowStart);
    if (recent.length !== records.length) {
      this.records.set(key, recent);
    }

    const allowed = recent.length < maxRequests;
    if (allowed) {
      recent.push(now);
      this.records.set(key, recent);
    }
    this.expirations.set(key, now + windowMs);

    return {
      allowed,
      remaining: Math.max(0, maxRequests - recent.length),
      reset: Math.ceil((now + windowMs) / 1000),
    };
  }

  destroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.records.clear();
    this.expirations.clear();
  }
}

class RedisRateLimitStore {
  constructor(redis, prefix) {
    this.redis = redis;
    this.prefix = prefix;
    this.scriptSha = null;

    this.luaScript = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local window_ms = tonumber(ARGV[2])
      local max = tonumber(ARGV[3])

      redis.call('ZREMRANGEBYSCORE', key, 0, now - window_ms)
      local count = redis.call('ZCARD', key)
      local allowed = 0
      if count < max then
        redis.call('ZADD', key, now, now .. ':' .. count)
        count = count + 1
        allowed = 1
      end
      local ttl = math.ceil(window_ms / 1000) + 1
      redis.call('EXPIRE', key, ttl)
      return {allowed, count, max}
    `;
  }

  async _loadScript() {
    if (this.scriptSha) return this.scriptSha;
    this.scriptSha = await this.redis.script("load", this.luaScript);
    return this.scriptSha;
  }

  _key(key) {
    return this.prefix + key;
  }

  async check(key, windowSeconds, maxRequests) {
    const sha = await this._loadScript();
    const k = this._key(key);
    const windowMs = windowSeconds * 1000;
    const now = Date.now();

    try {
      const result = await this.redis.evalsha(
        sha,
        1,
        k,
        now,
        windowMs,
        maxRequests,
      );
      const [allowed, count, max] = result;
      return {
        allowed: allowed === 1,
        remaining: Math.max(0, max - count),
        reset: Math.ceil((now + windowMs) / 1000),
      };
    } catch (err) {
      if (err.message && err.message.includes("NOSCRIPT")) {
        this.scriptSha = null;
        return this.check(key, windowSeconds, maxRequests);
      }
      throw err;
    }
  }

  async reset(key) {
    await this.redis.del(this._key(key));
  }

  destroy() {}
}

let storeInstance = null;

function init(mode, redisClient, prefix) {
  if (storeInstance) return storeInstance;
  storeInstance =
    mode === "redis"
      ? new RedisRateLimitStore(redisClient, prefix || "")
      : new MemoryRateLimitStore();
  return storeInstance;
}

function getStore() {
  if (!storeInstance) throw new Error("RateLimitStore 未初始化");
  return storeInstance;
}

function createMemoryStore() {
  return new MemoryRateLimitStore();
}

module.exports = { init, getStore, createMemoryStore };
