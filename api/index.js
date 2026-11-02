// Vercel Serverless 入口：复用 Express 版应用，实例在 Lambda 复用期间缓存
const createApp = require("../core/app");

let appPromise = null;

module.exports = async function handler(req, res) {
  if (!appPromise) {
    appPromise = createApp()
      .then(({ app }) => app)
      .catch((error) => {
        appPromise = null; // 失败允许下次重试
        throw error;
      });
  }
  const app = await appPromise;
  return app(req, res);
};
