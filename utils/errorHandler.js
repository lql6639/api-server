const fs = require("fs");
const path = require("path");
const config = require("./configLoader");
const logger = require("./logger");

const templatePath = path.resolve(
  __dirname,
  "..",
  config?.error?.templatePath || "template/error.html",
);
let templatePromise = null;

const errorMessages = {
  400: {
    message: "错误的请求",
    description: "抱歉，您的请求出现错误",
  },
  401: {
    message: "未授权访问",
    description: "抱歉，您的请求未被授权",
  },
  403: {
    message: "访问被拒绝",
    description: "抱歉，您的访问不被允许。",
  },
  404: {
    message: "资源不存在",
    description: "抱歉，您访问的页面不存在或已被移除",
  },
  409: {
    message: "资源冲突",
    description: "抱歉，您请求的资源与服务端存在冲突",
  },
  500: {
    message: "服务器内部错误",
    description: "抱歉，服务器遇到了一个意外错误",
  },
  501: {
    message: "功能未实现",
    description: "抱歉，服务器不支持此请求方法",
  },
  502: {
    message: "网关错误",
    description: "抱歉，服务器收到了无效响应",
  },
  429: {
    message: "请求过于频繁",
    description: "抱歉，您的请求过于频繁，请稍后重试",
  },
  503: {
    message: "服务暂不可用",
    description: "抱歉，服务器暂时无法处理请求",
  },
};

async function sendError(res, statusCode) {
  const errorInfo = errorMessages[statusCode] || errorMessages[500];

  try {
    if (!templatePromise) {
      templatePromise = fs.promises.readFile(templatePath, "utf-8");
    }
    const template = await templatePromise;
    const html = template
      .replace(/\$\{projectName\}/g, () => config.projectName)
      .replace(/\$\{code\}/g, () => statusCode)
      .replace(/\$\{message\}/g, () => errorInfo.message)
      .replace(/\$\{description\}/g, () => errorInfo.description);

    return res.status(statusCode).send(html);
  } catch (error) {
    templatePromise = null;
    return res.status(statusCode).json({
      code: statusCode,
      message: errorInfo.message,
      description: errorInfo.description,
    });
  }
}

function errorHandlerMiddleware(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }
  const statusCode = err.statusCode || err.status || 500;
  logger.error(`${statusCode} ${err.message}`, {
    rid: req.rid,
    method: req.method,
    url: req.url,
    stack: err.stack,
  });
  sendError(res, statusCode);
}

module.exports = {
  sendError,
  errorHandlerMiddleware,
  errorMessages,
};
