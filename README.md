# API Server

基于 Express 的 API 聚合服务，自动加载 `v1/` 目录下的模块，同时提供静态资源与 Markdown 文档渲染。

## 快速开始

```bash
npm install
npm run dev
```

访问 `http://localhost:8633/`

## 内置模块

| 模块 | 路径 | 说明 |
|------|------|------|
| 随机图片 | `/v1/img` | 横/竖屏自适应，302/json/text/img |
| IP 查询 | `/v1/ipinfo` | 多上游容灾，自动重试 + 负载均衡 |
| 天气 | `/v1/weather` | IP 定位城市，实时 + 7 天预报 |

查看所有端点：`GET /v1/meta`

## 项目结构

```
server.js              # 入口（内置 cluster / PM2 自适应）
core/
  app.js               # Express 应用创建 + Redis/Store 初始化
  apiLoader.js         # 自动加载 v1/ 模块 + /v1/meta 接口
libs/
  redisClient.js       # Redis 连接管理（重连、错误捕获、优雅关闭）
  cacheStore.js        # 缓存抽象层（Memory / Redis 双后端）
  rateLimitStore.js    # 限流抽象层（滑动窗口 + Lua 原子脚本）
utils/
  configLoader.js      # 统一配置加载
  staticServer.js      # 静态资源 / Markdown 路由
  markdownRenderer.js  # Markdown → HTML
  errorHandler.js      # 错误页面渲染
  rateLimiter.js       # IP 滑动窗口限流（支持集群共享）
  logger.js            # 访问日志
  httpClient.js        # axios 封装
  corsHandler.js       # CORS
  urlDecoder.js        # URL 解码
  mimeTypes.js         # MIME 映射
v1/
  img/                 # 随机图片模块
  ipinfo/              # IP 信息模块
  weather/             # 天气模块
template/
  index.html           # 首页（动态加载 API 端点）
  error.html           # 错误页
  markdown.html        # Markdown 文档渲染模板
ecosystem.config.js    # PM2 零停机部署配置
deploy.sh              # Webhook 部署脚本
```

## 技术栈

- Express 4 + axios + marked + ioredis
- Redis 集中式缓存与限流（PM2 cluster 多 worker 共享状态）
- 内置 Node.js cluster 多进程（PM2 环境下自动适配）
- 模板变量替换（`${projectName}` 等，见 [配置文档](docs/config.md)）

## 文档

- [配置](docs/config.md)
- [插件开发](docs/plugin.md)
- [CI/CD 部署](docs/cicd.md)
- [IP 查询](docs/ip.md)
- [天气](docs/weather.md)
- [随机图片](docs/img.md)
