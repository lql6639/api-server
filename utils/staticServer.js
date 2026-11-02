const cluster = require("cluster");
const fs = require("fs");
const path = require("path");

const logger = require("./logger");
const { getMimeType } = require("./mimeTypes");
const { sendError } = require("./errorHandler");
const { serveMarkdown, serveRawMarkdown } = require("./markdownRenderer");

const PROJECT_ROOT = path.resolve(__dirname, "..");

async function serveFile(res, filePath) {
  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) {
      return sendError(res, 404);
    }

    const mimeType = getMimeType(filePath);

    if (mimeType === "text/html" || filePath.endsWith(".html")) {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const config = require("./configLoader");
      const timeWindow = config?.rateLimit?.timeWindow || 60;
      const htmlContent = content
        .replace(/\$\{projectName\}/g, config.projectName)
        .replace(/\$\{port\}/g, config.port || 8633)
        .replace(/\$\{apiDir\}/g, config.apiDir || "v1")
        .replace(/\$\{maxRequests\}/g, config?.rateLimit?.maxRequests || 100)
        .replace(/\$\{timeWindow\}/g, timeWindow)
        .replace(/\$\{year\}/g, new Date().getFullYear());

      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Length", Buffer.byteLength(htmlContent));
      logger.debug(`静态文件: ${filePath}`, { mime: mimeType });
      return res.send(htmlContent);
    }

    logger.debug(`静态文件: ${filePath}`, { mime: mimeType });
    return new Promise((resolve) => {
      res.sendFile(
        filePath,
        { headers: { "Content-Type": mimeType } },
        (error) => {
          if (error) {
            logger.error(`无法提供文件: ${filePath}`, { error: error.message });
            if (!res.headersSent) {
              sendError(res, error.statusCode === 404 ? 404 : 500);
            } else {
              res.end();
            }
          }
          resolve();
        },
      );
    });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return sendError(res, 404);
    }
    logger.error(`无法提供文件: ${filePath}`, { error: error.message });
    return sendError(res, 500);
  }
}

function setupStaticRoutes(app, config, markdownRenderer) {
  const staticDir = path.resolve(PROJECT_ROOT, config.staticDir || "public");
  const resolvedStaticDir = path.resolve(staticDir);

  app.get("*", async (req, res, next) => {
    try {
      if (req.path === "/") {
        const indexPath = path.resolve(
          PROJECT_ROOT,
          config?.index?.templatePath || "template/index.html",
        );
        return await serveFile(res, indexPath);
      }

      const filePath = path.resolve(path.join(staticDir, req.path));
      if (
        !filePath.startsWith(resolvedStaticDir + path.sep) &&
        filePath !== resolvedStaticDir
      ) {
        return sendError(res, 404);
      }

      if (req.path.endsWith(".raw.md")) {
        const actualPath = `${req.path.slice(0, -7)}.md`;
        const resolvedPath = path.resolve(path.join(staticDir, actualPath));
        if (
          !resolvedPath.startsWith(resolvedStaticDir + path.sep) &&
          resolvedPath !== resolvedStaticDir
        ) {
          return sendError(res, 404);
        }
        return await serveRawMarkdown(res, resolvedPath);
      }

      if (req.path.endsWith(".md")) {
        logger.debug(`渲染文档: ${req.path}`);
        return await serveMarkdown(res, filePath, markdownRenderer);
      }

      await serveFile(res, filePath);
    } catch (error) {
      logger.error(`静态路由错误`, { error: error.message });
      next(error);
    }
  });

  if (cluster.isPrimary || process.env.IS_PRIMARY_WORKER === "1") {
    logger.info("静态路由已加载");
  }
}

module.exports = {
  serveFile,
  setupStaticRoutes,
};
