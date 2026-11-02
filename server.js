const cluster = require("cluster");
const os = require("os");
const config = require("./utils/configLoader");
const logger = require("./utils/logger");
const createApp = require("./core/app");

const port = Number(config.port) || 8633;
const host = String(config.host || "127.0.0.1");
const clusterConfig =
  config && typeof config === "object" ? config.cluster : null;
const clusterEnabled = Boolean(clusterConfig && clusterConfig.enabled);
const managedByPM2 = "pm_id" in process.env;

if (!managedByPM2 && clusterEnabled && cluster.isPrimary) {
  let shuttingDown = false;
  const configured = Number(clusterConfig?.workers);
  const cpuCount = Math.max(1, Number(os.cpus().length) || 1);
  const workers = configured > 0 ? configured : cpuCount;

  logger.info(`启动 ${workers} 个 Worker 进程`, { pid: process.pid });

  for (let i = 0; i < workers; i++) {
    const worker = cluster.fork({ IS_PRIMARY_WORKER: i === 0 ? "1" : "0" });
    logger.debug(`fork worker pid=${worker.process.pid}`);
  }

  cluster.on("exit", (worker, code) => {
    if (shuttingDown) return;
    logger.warn(`Worker 退出，重启中`, {
      workerPid: worker.process.pid,
      code,
      pid: process.pid,
    });
    cluster.fork({ IS_PRIMARY_WORKER: "0" });
  });

  const shutdownPrimary = (exitCode) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceTimer = setTimeout(() => process.exit(1), 5000);
    forceTimer.unref();
    cluster.disconnect(() => {
      clearTimeout(forceTimer);
      process.exit(exitCode);
    });
  };
  const handlePrimaryError = (error) => {
    const message =
      error instanceof Error ? error.stack || error.message : String(error);
    logger.error("主进程未捕获异常", { error: message });
    shutdownPrimary(1);
  };
  process.on("SIGTERM", () => shutdownPrimary(0));
  process.on("SIGINT", () => shutdownPrimary(0));
  process.on("uncaughtException", handlePrimaryError);
  process.on("unhandledRejection", handlePrimaryError);
} else {
  (async () => {
    try {
      const { app, limiter, destroy } = await createApp();
      const server = app.listen(port, host, () => {
        if (process.send) process.send("ready");
        if (
          managedByPM2 ||
          !clusterEnabled ||
          process.env.IS_PRIMARY_WORKER === "1"
        ) {
          logger.info(`服务已启动: http://${host}:${port}`, {
            pid: process.pid,
          });
        }
      });

      let shuttingDown = false;
      const shutdown = (exitCode = 0) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info("收到关闭信号，等待请求完成");
        const forceTimer = setTimeout(() => {
          logger.error("服务关闭超时，强制退出");
          if (typeof server.closeAllConnections === "function") {
            server.closeAllConnections();
          }
          process.exit(1);
        }, 5000);
        forceTimer.unref();
        server.close(async () => {
          clearTimeout(forceTimer);
          await Promise.allSettled([
            destroy(),
            Promise.resolve(limiter.destroy()),
          ]);
          process.exit(exitCode);
        });
      };
      const handleFatalError = (error) => {
        const message =
          error instanceof Error ? error.stack || error.message : String(error);
        logger.error("未捕获的进程异常", { error: message });
        shutdown(1);
      };
      process.on("SIGTERM", () => shutdown(0));
      process.on("SIGINT", () => shutdown(0));
      process.on("uncaughtException", handleFatalError);
      process.on("unhandledRejection", handleFatalError);
    } catch (error) {
      const message =
        error instanceof Error ? error.stack || error.message : String(error);
      logger.error("服务启动失败", { error: message });
      process.exit(1);
    }
  })();
}
