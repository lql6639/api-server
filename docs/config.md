# 配置

服务启动时读取项目根目录的 `server-config.json`。复制 `server-config.example.json` 并重命名即可使用。

## 完整示例

```json
{
  "projectName": "API Server",
  "host": "127.0.0.1",
  "port": 8633,
  "trustProxy": "loopback",
  "staticDir": "public",
  "apiDir": "v1",
  "index": {
    "templatePath": "template/index.html"
  },
  "error": {
    "templatePath": "template/error.html"
  },
  "markdown": {
    "templatePath": "template/markdown.html"
  },
  "log": {
    "level": "info",
    "file": true,
    "dir": "logs"
  },
  "rateLimit": {
    "enabled": true,
    "timeWindow": 60,
    "maxRequests": 100
  },
  "cluster": {
    "enabled": true,
    "workers": 0
  },
  "redis": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 6379,
    "password": "",
    "db": 0,
    "keyPrefix": "api-server:"
  }
}
```

## 字段说明

### 基础

| 字段 | 类型 | 说明 |
|------|------|------|
| `projectName` | string | 站点标题与模板变量 |
| `host` | string | 监听地址，默认 `127.0.0.1` |
| `port` | number | 监听端口，默认 `8633` |
| `trustProxy` | string/boolean/array | Express 可信代理配置，默认 `loopback` |
| `staticDir` | string | 静态资源根目录，默认 `public` |
| `apiDir` | string | API 模块根目录，默认 `v1` |

### 页面模板

| 字段 | 说明 |
|------|------|
| `index.templatePath` | `/` 首页模板 |
| `error.templatePath` | HTTP 错误页模板 |
| `markdown.templatePath` | Markdown 渲染模板 |

### 日志

| 字段 | 说明 |
|------|------|
| `log.level` | 日志级别：`error`、`warn`、`info`、`debug` |
| `log.file` | 是否写入日志文件 |
| `log.dir` | 按月份存放日志的目录，默认 `logs` |

### 限流

| 字段 | 说明 |
|------|------|
| `rateLimit.enabled` | 是否启用限流 |
| `rateLimit.timeWindow` | 统计窗口（秒） |
| `rateLimit.maxRequests` | 窗口内最大请求数，`0` = 不限流 |

客户端 IP 统一使用 Express 解析后的 `req.ip`。不要配置自定义来源头。

### 反向代理

默认配置仅监听 `127.0.0.1`，并只信任本机回环代理。反向代理必须与服务部署在同一台主机，并覆盖客户端传入的转发头：

```nginx
location / {
    proxy_pass http://127.0.0.1:8633;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
}
```

若代理位于 Docker 网桥、CDN 或其他主机，必须把 `trustProxy` 设置为明确的代理 IP/CIDR 白名单；不要设置为 `true`。

### 多进程

| 字段 | 说明 |
|------|------|
| `cluster.enabled` | 是否启用内置 cluster 多进程 |
| `cluster.workers` | `0` = CPU 核心数，`>0` = 指定数量 |

**PM2 共存**：当进程由 PM2 管理时（检测到 `pm_id` 环境变量），内置 cluster 自动关闭，由 PM2 负责多进程管理和零停机 reload。直接 `node server.js` 启动时则使用内置 cluster。

### Redis（集群缓存与限流共享）

| 字段 | 类型 | 说明 |
|------|------|------|
| `redis.enabled` | boolean | 是否启用 Redis；`false` 时回退内存模式（cluster 下限流不共享） |
| `redis.host` | string | Redis 主机地址 |
| `redis.port` | number | Redis 端口，默认 `6379` |
| `redis.password` | string | Redis 密码（可选，优先使用 `REDIS_PASSWORD` 环境变量） |
| `redis.db` | number | Redis 数据库编号，默认 `0` |
| `redis.keyPrefix` | string | 键前缀，默认 `""`，推荐 `"api-server:"` |

示例：

```json
"redis": {
  "enabled": true,
  "host": "127.0.0.1",
  "port": 6379,
  "password": "",
  "db": 0,
  "keyPrefix": "api-server:"
}
```

**密码优先级**：环境变量 `REDIS_PASSWORD` > 配置文件 `redis.password`。PM2 部署时通过 `ecosystem.config.js` 的 `env` 字段注入更安全。

**启动行为**：Redis 启用时，若连接失败则服务直接拒绝启动（`process.exit(1)`）；禁用时使用进程内存模式。

## HTML 模板变量

返回 `.html` 文件时自动替换：

| 变量 | 来源 |
|------|------|
| `${projectName}` `${port}` `${apiDir}` | 配置 |
| `${maxRequests}` `${timeWindow}` | 限流配置 |
| `${year}` | 当前年份 |

## 生效方式

修改 `server-config.json` 后需重启进程。PM2 环境下 `pm2 reload` 即可。
