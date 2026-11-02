const logger = require("./logger");

function urlDecoderMiddleware(req, res, next) {
  try {
    const queryIndex = req.url.indexOf("?");
    const pathname = queryIndex === -1 ? req.url : req.url.slice(0, queryIndex);
    const query = queryIndex === -1 ? "" : req.url.slice(queryIndex);
    req.url = decodeURIComponent(pathname) + query;
  } catch (error) {
    logger.warn(`URL 解码失败`, { url: req.url, error: error.message });
  }
  next();
}

module.exports = urlDecoderMiddleware;
