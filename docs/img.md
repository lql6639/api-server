# 随机图片接口（/v1/img）

提供基于上游列表的随机图片分发与列表查询能力，并支持 302 跳转、纯文本 URL、JSON 数据以及直接输出图片流。

## 接口列表

### 1. 随机图片

- **路径**：`GET /v1/img`
- **说明**：从缓存的图片列表中随机选择一张；默认根据 `User-Agent` 自动选择横屏或竖屏图片源。
- **相关路径**：
  - `GET /v1/img`：根据 `User-Agent` 自动选择（默认）
  - `GET /v1/img/ua`：根据 `User-Agent` 自动选择
  - `GET /v1/img/h`：强制横屏
  - `GET /v1/img/v`：强制竖屏
- **通用参数**：
  - `type` (可选)：返回格式
    - `302`（默认）：302 重定向到随机图片 URL
    - `text`：返回纯文本的随机图片 URL
    - `json`：返回 JSON，包含图片的基本信息
    - `img`：由服务端拉取图片并直接输出图片流

#### 1.1 302 重定向（默认）

- **请求**：
  - `GET /v1/img`
  - 或显式指定：`GET /v1/img?type=302`
- **行为**：
  - 返回 `302 Found`
  - 响应头 `Location` 为随机图片的完整 URL，例如：
    - `https://api.lovlin.eu.cc/image/background/100066591_p0.png`

#### 1.2 纯文本 URL

- **请求**：
  - `GET /v1/img?type=text`
- **响应**：
  - `Content-Type: text/plain; charset=utf-8`
  - 响应体为一行文本，即随机图片完整 URL：

```text
https://api.lovlin.eu.cc/image/background/100066591_p0.png
```

#### 1.3 JSON 格式

- **请求**：
  - `GET /v1/img?type=json`
- **响应结构**：

```json
{
  "status": "success",
  "time": 1730000000000,
  "data": {
    "id": "1",
    "name": "100066591_p0.png",
    "url": "https://api.lovlin.eu.cc/image",
    "path": "/background/100066591_p0.png",
    "fullUrl": "https://api.lovlin.eu.cc/image/background/100066591_p0.png"
  }
}
```

字段说明：

- `status`：请求状态，成功为 `"success"`
- `time`：时间戳（`Date.now()`）
- `data.id`：当前图片在列表中的序号（字符串，从 `"1"` 开始）
- `data.name`：文件名
- `data.url`：基础 URL（即配置中的 `url`，不带末尾 `/`）
- `data.path`：图片路径（以 `/` 开头）
- `data.fullUrl`：拼接后的完整图片 URL

#### 1.4 直接输出图片流

- **请求**：
  - `GET /v1/img?type=img`
- **行为**：
  - 在后端内部对随机图片 URL 发起请求，并将响应流式转发给客户端。
  - 响应头中的 `Content-Type` 等信息（如 `image/png`、`image/jpeg`）会尽量保持与上游一致。

## 2. 图片列表

- **路径**：`GET /v1/img/list`
- **说明**：返回全部图片的列表，可选纯文本或 JSON；默认根据 `User-Agent` 自动选择横屏或竖屏图片源。
- **相关路径**：
  - `GET /v1/img/list`：根据 `User-Agent` 自动选择（默认）
  - `GET /v1/img/list/h`：强制横屏列表
  - `GET /v1/img/list/v`：强制竖屏列表
- **参数**：
  - `type` (Query，可选)：
    - `json`（默认）：返回 JSON 列表
    - `text`：返回纯文本列表

### 2.1 JSON 列表

- **请求**：
  - `GET /v1/img/list` 或 `GET /v1/img/list?type=json`
- **响应示例**：

```json
{
  "status": "success",
  "total": 3,
  "time": 1730000000000,
  "data": [
    {
      "id": "1",
      "name": "100066591_p0.png",
      "url": "https://api.lovlin.eu.cc/image",
      "path": "/background/100066591_p0.png"
    },
    {
      "id": "2",
      "name": "100257227_p0.png",
      "url": "https://api.lovlin.eu.cc/image",
      "path": "/background/100257227_p0.png"
    },
    {
      "id": "3",
      "name": "100339220_p0.jpg",
      "url": "https://api.lovlin.eu.cc/image",
      "path": "/background/100339220_p0.jpg"
    }
  ]
}
```

其中：

- `total`：图片总数
- `data`：每一项对应一张图片的基础信息

### 2.2 纯文本列表

- **请求**：
  - `GET /v1/img/list?type=text`
- **响应**：
  - `Content-Type: text/plain; charset=utf-8`
  - 每行一个完整 URL，形如：

```text
https://api.lovlin.eu.cc/image/background/100066591_p0.png
https://api.lovlin.eu.cc/image/background/100257227_p0.png
https://api.lovlin.eu.cc/image/background/100339220_p0.jpg
```

## 缓存与并发行为

- 图片列表会被缓存，缓存时间由配置 `cache_ttl` 控制（单位：秒）。
- Redis 启用时：多个 PM2 worker 共享同一份缓存，分布式锁防止重复拉取上游。
- Redis 禁用时：回退进程内内存缓存。
- 横屏与竖屏分别维护独立缓存，并在启动后后台并行预热。
- 当缓存过期时：
  - 若已有旧数据：请求仍然立即返回旧数据，同时在后台异步刷新。
  - 若没有任何缓存：当前请求会等待上游接口返回。
- 并发情况下，多次刷新会被合并为单次上游请求，避免击穿与重复拉取。

## User-Agent 规则

- 命中以下任一关键词则视为竖屏：`Mobile|Android|iPhone|iPad|iPod|HarmonyOS|Windows Phone`
- 未命中或无 `User-Agent`：默认横屏

示例：

```json
{
  "url": "https://api.lovlin.eu.cc/image",
  "cache_ttl": 3600,
  "upstream": {
    "horizontal": "https://api.lovlin.eu.cc/api/images/list?path=/background",
    "vertical": "https://api.lovlin.eu.cc/api/images/list?path=/background-phone"
  },
  "timeout_ms": 10000
}
```

字段说明：

- `url`：基础图片 URL，拼接时会自动去掉末尾 `/`。
- `cache_ttl`：缓存有效期（秒）。
- `upstream.horizontal`：横屏图片列表上游完整 URL。
- `upstream.vertical`：竖屏图片列表上游完整 URL。
- `upstream_headers`：可选，上游请求附加请求头（例如 `Cookie`/`Authorization`）。
- `upstream_headers_horizontal`：可选，仅横屏上游附加请求头（会覆盖同名字段）。
- `upstream_headers_vertical`：可选，仅竖屏上游附加请求头（会覆盖同名字段）。
- `timeout_ms`：请求上游列表与图片时的超时时间（毫秒）。

## HTTP 缓存控制

所有 `/v1/img` 相关接口都会统一返回如下响应头，用于禁用中间层缓存：

```text
Cache-Control: no-store, no-cache, max-age=0, must-revalidate, proxy-revalidate
```
