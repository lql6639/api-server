const fs = require("fs");
const path = require("path");

const configPath = path.resolve(__dirname, "..", "server-config.json");
let cachedConfig = null;

function parseBoolean(value) {
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

// 云托管平台通过环境变量注入端口/主机，需覆盖本地配置文件
function applyEnvOverrides(config) {
  const env = process.env;
  const isServerless = Boolean(
    env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME || env.NETLIFY,
  );

  if (env.PORT && Number(env.PORT) > 0) {
    config.port = Number(env.PORT);
  }
  if (env.HOST) {
    config.host = env.HOST;
  }
  if (env.TRUST_PROXY !== undefined) {
    const flag = parseBoolean(env.TRUST_PROXY);
    if (flag !== null) config.trustProxy = flag;
  } else if (isServerless) {
    // serverless 平台的请求都经过自家网关，不信任代理会拿不到真实客户端 IP
    config.trustProxy = true;
  }
  if (env.CLUSTER_ENABLED !== undefined) {
    const flag = parseBoolean(env.CLUSTER_ENABLED);
    if (flag !== null) {
      config.cluster = { ...(config.cluster || {}), enabled: flag };
    }
  }
  if (env.REDIS_ENABLED !== undefined) {
    const flag = parseBoolean(env.REDIS_ENABLED);
    if (flag !== null) {
      config.redis = { ...(config.redis || {}), enabled: flag };
    }
  }
  if (env.LOG_LEVEL) {
    config.log = { ...(config.log || {}), level: env.LOG_LEVEL };
  }
  if (env.LOG_FILE !== undefined) {
    const flag = parseBoolean(env.LOG_FILE);
    if (flag !== null) {
      config.log = { ...(config.log || {}), file: flag };
    }
  } else if (isServerless && config.log && config.log.file) {
    // serverless 文件系统只读，文件日志写不了，自动退回 console 输出
    config.log = { ...(config.log || {}), file: false };
  }

  return config;
}

// serverless 平台可能因为打包裁剪拿不到配置文件，此时用内置默认值继续服务，
// 而不是让整个函数 crash（process.exit 在 Lambda 里等于一次失败调用）
function defaultConfig() {
  return {
    projectName: "API Server",
    host: "127.0.0.1",
    port: 8633,
    trustProxy: "loopback",
    staticDir: "public",
    apiDir: "v1",
    index: { templatePath: "template/index.html" },
    error: { templatePath: "template/error.html" },
    markdown: { templatePath: "template/markdown.html" },
    log: { level: "info", file: false, dir: "logs" },
    rateLimit: { enabled: true, timeWindow: 60, maxRequests: 100 },
    cluster: { enabled: false, workers: 0 },
    redis: {
      enabled: false,
      host: "127.0.0.1",
      port: 6379,
      password: "",
      db: 0,
      keyPrefix: "api-server:",
    },
  };
}

function isServerlessEnv() {
  return Boolean(
    process.env.VERCEL ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.NETLIFY,
  );
}

function loadConfig() {
  if (cachedConfig) {
    return cachedConfig;
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    cachedConfig = applyEnvOverrides(JSON.parse(raw));
    return cachedConfig;
  } catch (error) {
    if (error.code === "ENOENT") {
      console.error("[错误] 配置文件不存在: " + configPath);
    } else if (error instanceof SyntaxError) {
      console.error("[错误] 配置文件 JSON 格式错误: " + error.message);
    } else {
      console.error("[错误] 无法读取配置文件:", error);
    }

    if (isServerlessEnv()) {
      console.error("[警告] serverless 环境下改用内置默认配置继续启动");
      cachedConfig = applyEnvOverrides(defaultConfig());
      return cachedConfig;
    }

    process.exit(1);
  }
}

module.exports = loadConfig();
