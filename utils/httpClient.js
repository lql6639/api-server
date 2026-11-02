const axios = require("axios");
const logger = require("./logger");

const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const SENSITIVE_QUERY_KEYS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "appid",
  "key",
  "password",
  "secret",
  "token",
]);

function redactUrl(value) {
  try {
    const url = new URL(String(value));
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return url.toString();
  } catch {
    return String(value || "").replace(
      /([?&](?:access_token|api_key|apikey|appid|key|password|secret|token)=)[^&]*/gi,
      "$1[REDACTED]",
    );
  }
}

class HttpClient {
  constructor(config = {}) {
    const maxResponseBytes =
      Number(config.maxResponseBytes) > 0
        ? Number(config.maxResponseBytes)
        : DEFAULT_MAX_RESPONSE_BYTES;
    this.axios = axios.create({
      timeout: config.timeout || 10000,
      maxContentLength: maxResponseBytes,
      maxBodyLength: maxResponseBytes,
      headers: config.headers || {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
        Accept: "application/json",
      },
    });

    this.axios.interceptors.response.use(
      (response) => response,
      (error) => {
        return Promise.reject(this.handleError(error));
      },
    );
  }

  handleError(error) {
    if (error.response) {
      const msg = `HTTP ${error.response.status}: ${error.response.statusText}`;
      logger.warn(`上游请求失败: ${msg}`, {
        status: error.response.status,
        url: redactUrl(error.config?.url),
      });
      const err = new Error(msg);
      err.statusCode = error.response.status;
      err.data = error.response.data;
      return err;
    } else if (error.code === "ECONNABORTED") {
      logger.warn(`上游请求超时`, { url: redactUrl(error.config?.url) });
      const err = new Error("请求超时");
      err.code = "TIMEOUT";
      return err;
    } else if (error.request) {
      logger.warn(`上游请求无响应`, { url: redactUrl(error.config?.url) });
      const err = new Error("未收到来自服务器的响应");
      err.code = "ECONNREFUSED";
      return err;
    } else {
      logger.warn(`上游请求异常`, { error: error.message });
      return error;
    }
  }

  async get(url, params = {}, config = {}) {
    logger.debug(`GET ${redactUrl(url)}`);
    const response = await this.axios.get(url, {
      params,
      ...config,
    });
    return response.data;
  }

  async post(url, data = {}, config = {}) {
    logger.debug(`POST ${redactUrl(url)}`);
    const response = await this.axios.post(url, data, config);
    return response.data;
  }
}

module.exports = HttpClient;
