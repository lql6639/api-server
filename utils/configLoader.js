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

  if (env.PORT && Number(env.PORT) > 0) {
    config.port = Number(env.PORT);
  }
  if (env.HOST) {
    config.host = env.HOST;
  }
  if (env.TRUST_PROXY !== undefined) {
    const flag = parseBoolean(env.TRUST_PROXY);
    if (flag !== null) config.trustProxy = flag;
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

  return config;
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
    process.exit(1);
  }
}

module.exports = loadConfig();
