const fs = require("fs");
const path = require("path");

const configPath = path.resolve(__dirname, "..", "server-config.json");
let cachedConfig = null;

function loadConfig() {
  if (cachedConfig) {
    return cachedConfig;
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    cachedConfig = JSON.parse(raw);
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
