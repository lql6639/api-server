# 站点统计接口（/v1/stats）

站点 PV / UV 统计，数据存 Cloudflare D1 数据库。**读写均公开**，替代已停止服务的第三方统计（不蒜子）。

## 端点

| 方法   | 路径        | 说明                     | 鉴权 |
| ------ | ----------- | ------------------------ | ---- |
| `GET`  | `/v1/stats` | 读取站点统计             | 公开 |
| `POST` | `/v1/stats` | 上报一次访问（页面加载） | 公开 |

## 统计口径

- **总访问量 PV**：每次上报 +1，SPA 路由切换各算一次。
- **总访客数 UV**：`IPv4 /24`、`IPv6 /48` 网段 + `User-Agent` 做 SHA-256 后取前 24 位，去重计数，不存原始 IP。
- 爬虫 / 预渲染 / 命令行 UA（bot、spider、crawler、curl、wget 等）不计入，返回 `{ "skipped": true }`。

## 调用示例

### 读取统计（公开）

```bash
curl 'https://server.lovlin.cn/v1/stats'
curl 'https://server.lovlin.cn/v1/stats?path=/posts/2026/0921.html'
```

### 上报访问（公开）

```bash
curl -X POST 'https://server.lovlin.cn/v1/stats'
  -H 'Content-Type: application/json'
  -d '{"path":"/posts/2026/0921.html"}'
```

前端调用：

```js
fetch('https://server.lovlin.cn/v1/stats', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: location.pathname }),
  keepalive: true
})
```

## 响应

### 读取

```json
{
  "success": true,
  "data": {
    "site_pv": 1280,
    "site_uv": 316
  }
}
```

带 `?path=` 时额外返回该页面 PV：

```json
{
  "success": true,
  "data": { "site_pv": 1280, "site_uv": 316, "path": "/posts/2026/0921.html", "page_pv": 42 }
}
```

### 上报

返回上报后的最新统计，结构与 `GET` 一致（省一次请求）。

## 错误响应

| 状态码 | 场景                      |
| ------ | ------------------------- |
| `429`  | 触发限流（100 次 / 60 秒） |
| `500`  | 数据库未绑定 / 写入失败    |

```json
{ "success": false, "message": "统计数据库未绑定" }
```

## 数据表

| 表              | 说明                                                       |
| --------------- | ---------------------------------------------------------- |
| `stats_site`    | 站点累计 PV（单行，`id = 1`）                              |
| `stats_pages`   | 按路径累计 PV                                              |
| `stats_visitors`| 访问流水，一次访问一行；UV = `COUNT(DISTINCT visitor)`     |

`stats_visitors` 只追加不覆盖：同一访客来三次就是三行，`visits` 分别是 1、2、3，
主键为 `(visitor, visits)`。归属地按访客首次访问时查一次，后续行直接沿用。
