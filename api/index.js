// Vercel Serverless 入口：复用 Express 版应用，实例在函数复用期间缓存
//
// 注意：这里的 require 必须放在 handler 内部延迟执行。Vercel 的
// FUNCTION_INVOCATION_FAILED 会把模块级异常吞成一行通用报错，延迟加载后
// 任何初始化失败都能落到 sendFatal 里，把真实原因直接返回在响应体上。
// 排查完可用 API_DEBUG=0 关掉堆栈输出。

let appPromise = null;

function sendFatal(res, error) {
  const message = String((error && error.message) || error || "unknown error");
  const detail = String((error && error.stack) || "")
    .split("\n")
    .slice(1, 4)
    .map((line) => line.trim());

  const payload = {
    status: "error",
    time: Date.now(),
    message,
    code: (error && error.code) || undefined,
    runtime: {
      node: process.version,
      env: process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown",
      cwd: process.cwd(),
    },
  };
  if (process.env.API_DEBUG !== "0") {
    payload.detail = detail;
  }

  try {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
    }
    res.end(JSON.stringify(payload, null, 2));
  } catch (e) {
    // 响应对象都不可用时只能交给平台兜底
    console.error("[fatal] 无法输出错误响应:", e && e.message);
  }
}

module.exports = async function handler(req, res) {
  try {
    if (!appPromise) {
      appPromise = Promise.resolve()
        .then(() => require("../core/app"))
        .then((createApp) => createApp())
        .then((result) => result.app)
        .catch((error) => {
          appPromise = null; // 失败允许下次请求重试
          throw error;
        });
    }

    const app = await appPromise;
    return app(req, res);
  } catch (error) {
    console.error("[fatal] 函数初始化/执行失败:", error);
    return sendFatal(res, error);
  }
};
