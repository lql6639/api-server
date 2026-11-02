# API Server

基于 Express 的 API 聚合服务：自动加载 `v1/` 目录下的模块，提供静态资源与 Markdown 文档渲染。

## 快速开始

```bash
npm install
npm run dev
```

访问 `http://localhost:8633/`

## 项目结构

```js
api-server/
  core/
    apiLoader.js       # 自动加载 v1/ 下的模块，提供 /v1/meta 接口
    app.js             # Express 应用创建（中间件、路由、静态文件、Redis/Store 初始化）
  libs/
    redisClient.js     # Redis 连接管理（重连、错误捕获、优雅关闭）
    cacheStore.js      # 缓存抽象层（Memory / Redis 双后端，支持分布式锁）
    rateLimitStore.js  # 限流抽象层（滑动窗口 + Lua 原子脚本）
  utils/
    configLoader.js    # 统一配置加载（server-config.json）
    corsHandler.js     # CORS 跨域中间件
    errorHandler.js    # 错误页面渲染与兜底中间件
    httpClient.js      # axios 封装，统一错误分类
    logger.js          # 访问日志（异步批量文件写入）
    markdownRenderer.js  # markdown → HTML 渲染（marked）
    mimeTypes.js       # 静态文件 MIME 类型映射
    rateLimiter.js     # 基于 IP 的滑动窗口限流（支持 Redis 集群共享）
    staticServer.js    # 静态资源 / Markdown 文档路由
    urlDecoder.js      # URL 解码中间件
  v1/
    img/               # 随机图片接口
    ipinfo/            # IP 信息查询接口
    weather/           # 天气接口（实时 + 7 天预报）
  template/
    index.html         # 首页（动态加载 API 端点列表）
    error.html         # HTTP 错误页
    markdown.html      # Markdown 文档渲染模板
  docs/                # 项目文档（可访问 /docs/*.md）
  public/              # 静态资源（favicon、图片、CSS 等）
  tests/               # 单元测试（node:test）
  server.js            # 入口（内置 cluster / PM2 自适应）
  server-config.json   # 服务配置
  ecosystem.config.js  # PM2 生产部署配置
  deploy.sh            # Webhook 触发的零停机部署脚本
  webhook.example.json # webhook 配置示例
```

## 内置模块

| 模块     | 路径          | 说明                                       |
| -------- | ------------- | ------------------------------------------ |
| 随机图片 | `/v1/img`     | 横/竖屏自适应，支持 302/json/text/img 输出 |
| IP 查询  | `/v1/ipinfo`  | 多上游容灾，自动重试 + 负载均衡            |
| 天气     | `/v1/weather` | IP 自动定位城市，实时 + 7 天预报           |

可通过 `/v1/meta` 查看全部模块及端点详情。

## 中间件

请求经过以下中间件（按顺序）：

1. URL 解码
2. CORS（`GET, POST, OPTIONS`）
3. JSON 请求体解析
4. 访问日志
5. 限流（每 IP 100 次 / 60 秒，支持 Redis 集群共享计数器）

## 技术栈

- **Node.js** — 运行环境
- **Express 4** — Web 框架
- **axios** — HTTP 客户端
- **marked** — Markdown 渲染
- **ioredis** — Redis 客户端（集群缓存与限流共享）

## 文档

- [配置](config.md)
- [插件开发](plugin.md)
- [CI/CD 部署](cicd.md)
- [IP 查询](ip.md)
- [天气](weather.md)
- [随机图片](img.md)
