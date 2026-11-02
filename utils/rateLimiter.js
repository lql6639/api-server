const config = require("./configLoader");
const { sendError } = require("./errorHandler");
const logger = require("./logger");
const { createMemoryStore, getStore } = require("../libs/rateLimitStore");

class RateLimiter {
  constructor(rateLimitConfig) {
    const configuredWindow = Number(rateLimitConfig.timeWindow);
    const configuredMax = Number(rateLimitConfig.maxRequests);
    this.enabled =
      rateLimitConfig.enabled !== false && rateLimitConfig.enabled !== "false";
    this.timeWindow = configuredWindow > 0 ? configuredWindow : 60;
    this.maxRequests = Number.isFinite(configuredMax) ? configuredMax : 100;
    this.store = getStore();
    this.fallbackStore = createMemoryStore();
    this.apiPrefix = `/${config.apiDir || "v1"}`;

    if (this.enabled && this.maxRequests > 0) {
      logger.info(`限流器已启用: ${this.maxRequests}次/${this.timeWindow}s`);
    } else {
      logger.info("限流器已禁用");
    }
  }

  getClientIP(req) {
    return req.ip || "0.0.0.0";
  }

  async check(ip) {
    if (!this.enabled || this.maxRequests <= 0) {
      return { allowed: true };
    }
    const key = `ratelimit:${ip}`;
    try {
      return await this.store.check(key, this.timeWindow, this.maxRequests);
    } catch (error) {
      logger.error(`限流存储异常，使用本地限流`, { error: error.message });
      return this.fallbackStore.check(key, this.timeWindow, this.maxRequests);
    }
  }

  destroy() {
    if (this.store && typeof this.store.destroy === "function") {
      this.store.destroy();
    }
    this.fallbackStore.destroy();
  }

  middleware() {
    return (req, res, next) => {
      if (!this.enabled || this.maxRequests <= 0) {
        return next();
      }

      const ip = this.getClientIP(req);
      this.check(ip)
        .then((result) => {
          if (!result.allowed) {
            logger.debug(`限流触发`, {
              count: `${this.maxRequests}/${this.timeWindow}s`,
            });
            if (req.path.startsWith(this.apiPrefix)) {
              return res
                .status(429)
                .json({
                  status: "error",
                  time: Date.now(),
                  message: "请求过于频繁，请稍后重试",
                });
            }
            return sendError(res, 429);
          }
          next();
        })
        .catch((err) => {
          logger.error(`限流器检查异常`, { error: err.message });
          if (req.path.startsWith(this.apiPrefix)) {
            return res
              .status(503)
              .json({
                status: "error",
                time: Date.now(),
                message: "限流服务暂不可用",
              });
          }
          return sendError(res, 503);
        });
    };
  }
}

module.exports = RateLimiter;
