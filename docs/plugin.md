# 插件开发规范

系统启动时扫描 `v1/` 目录下的子目录，存在 `index.js` 的目录会自动挂载到 `/v1/{目录名}`。

## 目录结构

```js
v1/
  your-plugin/
    index.js      # 入口文件（必须）
    config.json   # 配置文件（可选）
```

## 最小示例

```js
const express = require("express");
const router = express.Router();

router.get("/", (req, res) => {
  res.json({ success: true, data: { message: "Hello" } });
});

module.exports = router;
```

访问：`GET /v1/your-plugin`

## meta 导出

导出 `meta` 对象后，插件会自动出现在首页端点列表中。

```js
const express = require("express");
const router = express.Router();

router.get("/", (req, res) => {
  res.json({ success: true });
});

router.get("/:id", (req, res) => {
  res.json({ success: true, id: req.params.id });
});

module.exports = router;

module.exports.meta = {
  name: "示例插件",
  description: "插件功能说明",
  endpoints: [
    { method: "GET", path: "/", description: "首页", params: "" },
    { method: "GET", path: "/:id", description: "详情", params: "路径参数" },
  ],
};
```

### meta 字段

| 字段        | 类型   | 说明     |
| ----------- | ------ | -------- |
| name        | string | 显示名称 |
| description | string | 简短描述 |
| endpoints   | array  | 端点列表 |

### endpoint 字段

| 字段        | 类型   | 说明                             |
| ----------- | ------ | -------------------------------- |
| method      | string | HTTP 方法（GET/POST/PUT/DELETE） |
| path        | string | 相对于模块的路径                 |
| description | string | 端点说明                         |
| params      | string | 参数说明                         |

## 读取配置

```js
const path = require("path");
const config = require(path.join(__dirname, "config.json"));
```

## 错误处理

```js
router.get("/", (req, res) => {
  if (!req.query.id) {
    return res.status(400).json({ success: false, message: "缺少 id" });
  }
  res.json({ success: true });
});
```

## 返回格式

建议统一返回格式：

```js
// 成功
{ success: true, data: { ... } }

// 失败
{ success: false, message: '错误信息' }
```

## 已启用的中间件

- JSON 请求体解析
- URL 解码
- CORS
- 访问日志
- 限流（Redis 集群共享，异常时 fail-open）

无需在插件中重复配置。

## 使用公共库

插件可直接引用项目提供的库：

```js
const { getStore } = require("../../libs/cacheStore");
const { getStore: getRateLimitStore } = require("../../libs/rateLimitStore");

const cache = getStore();
const rateLimiter = getRateLimitStore();
```

`libs/cacheStore` 提供 `get(key)` / `set(key, value, ttlSeconds)` / `setNX(key, value, ttlSeconds)` 等接口，底层根据配置自动选择 Memory 或 Redis 后端。

## 注意事项

- 新增或删除插件需要重启进程
- 使用 `npm run dev` 时文件变化会自动重启
- 元数据中的 `path` 不需要包含模块前缀，系统会自动拼接 `/v1/{模块名}`
