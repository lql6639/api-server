const crypto = require("crypto");
const path = require("path");
const express = require("express");
const config = require("../utils/configLoader");
const logger = require("../utils/logger");
const corsMiddleware = require("../utils/corsHandler");
const urlDecoderMiddleware = require("../utils/urlDecoder");
const RateLimiter = require("../utils/rateLimiter");
const loadApis = require("./apiLoader");
const { errorHandlerMiddleware } = require("../utils/errorHandler");
const { setupStaticRoutes } = require("../utils/staticServer");
const { MarkdownRenderer } = require("../utils/markdownRenderer");
const redisClient = require("../libs/redisClient");
const cacheStore = require("../libs/cacheStore");
const rateLimitStore = require("../libs/rateLimitStore");

async function createApp() {
  const redisCfg = config.redis;
  const redisEnabled = !!(redisCfg && redisCfg.enabled);

  if (redisEnabled) {
    try {
      redisClient.init(redisCfg);
      await redisClient.connect();
      logger.info("Redis 连接成功", {
        host: redisCfg.host,
        port: redisCfg.port,
      });
    } catch (err) {
      logger.error("Redis 连接失败，拒绝启动", { error: err.message });
      throw err;
    }
  }

  const mode = redisEnabled ? "redis" : "memory";
  const redis = redisEnabled ? redisClient.getClient() : null;
  const prefix = redisEnabled ? redisCfg.keyPrefix || "" : "";

  cacheStore.init(mode, redis, prefix);
  rateLimitStore.init(mode, redis, prefix);

  const app = express();
  app.disable("x-powered-by");
  app.set(
    "trust proxy",
    Object.prototype.hasOwnProperty.call(config, "trustProxy")
      ? config.trustProxy
      : "loopback",
  );

  app.use(urlDecoderMiddleware);
  app.use(corsMiddleware);
  app.use(express.json());

  app.use((req, res, next) => {
    req.rid = crypto.randomUUID().slice(0, 12);
    res.setHeader("X-Request-Id", req.rid);
    next();
  });

  logger.init(config.log || {});
  app.set("logger", logger);

  app.use(logger.middleware());

  const limiter = new RateLimiter(config.rateLimit || {});
  app.use(limiter.middleware());

  loadApis(app, config);

  const markdownTemplate = path.resolve(
    __dirname,
    "..",
    config?.markdown?.templatePath || "template/markdown.html",
  );
  const renderer = new MarkdownRenderer(markdownTemplate);
  setupStaticRoutes(app, config, renderer);

  app.use(errorHandlerMiddleware);

  return {
    app,
    limiter,
    destroy: async () => {
      if (redisEnabled) {
        await redisClient.destroy();
      }
      cacheStore.getStore().destroy();
      await logger.destroy();
    },
  };
}

module.exports = createApp;
