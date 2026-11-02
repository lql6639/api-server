const fs = require("fs");
const path = require("path");
const cluster = require("cluster");
const { sendError } = require("../utils/errorHandler");
const logger = require("../utils/logger");

function loadApis(app, config) {
  const apiRoot = path.resolve(__dirname, "..", config.apiDir || "v1");
  if (!fs.existsSync(apiRoot)) {
    return;
  }

  const modulesMeta = [];

  logger.debug(`扫描 API 目录: ${apiRoot}`);

  const modules = fs.readdirSync(apiRoot).filter((name) => {
    const full = path.join(apiRoot, name);
    try {
      return (
        fs.statSync(full).isDirectory() &&
        fs.existsSync(path.join(full, "index.js"))
      );
    } catch {
      return false;
    }
  });

  modules.forEach((name) => {
    const indexPath = path.join(apiRoot, name, "index.js");
    try {
      const router = require(indexPath);
      const base = `/${config.apiDir}/${name}`;
      app.use(base, router);
      if (router.meta) {
        modulesMeta.push({ id: name, ...router.meta });
      }
      if (cluster.isPrimary || process.env.IS_PRIMARY_WORKER === "1") {
        logger.info(`加载模块成功: ${name}`);
      }
    } catch (e) {
      logger.error(`加载模块失败: ${name}`, { error: e.message });
    }
  });

  app.get(`/${config.apiDir}/meta`, (req, res) => {
    res.json({
      project: config.projectName,
      apiDir: config.apiDir,
      modules: modulesMeta,
    });
  });

  app.use(`/${config.apiDir}`, (req, res) => {
    sendError(res, 404);
  });
}

module.exports = loadApis;
