# 分享接口（/v1/share）

日常分享（说说），数据存 Cloudflare D1 数据库。**读公开，写操作需 token 鉴权**。

## 端点

| 方法     | 路径            | 说明     | 鉴权 |
| -------- | --------------- | -------- | ---- |
| `GET`    | `/v1/share`     | 分享列表 | 公开 |
| `GET`    | `/v1/share/:id` | 单条分享 | 公开 |
| `POST`   | `/v1/share`     | 新增分享 | token |
| `PUT`    | `/v1/share/:id` | 修改分享 | token |
| `DELETE` | `/v1/share/:id` | 删除分享 | token |

## 鉴权

写操作（POST / PUT / DELETE）需要在请求头携带 token：

```
X-Share-Token: <token>
```

也可以在 URL 上传 `?token=<token>`（请求头优先）。

token 通过 `wrangler secret put SHARE_TOKEN` 配置在 Cloudflare 环境变量中，未配置时写操作默认放行（仅用于本地开发）。

## 数据字段

| 字段       | 类型            | 说明                     |
| ---------- | --------------- | ------------------------ |
| `id`       | number          | 自增主键                 |
| `date`     | string          | 分享时间，如 `2026-11-14 21:01` |
| `device`   | string          | 设备，如 `IPhone`        |
| `text`     | string          | 分享文字                 |
| `images`   | number          | 图片数量                 |
| `location` | string          | 位置                     |
| `createdAt`| number          | 创建时间戳（毫秒）       |

## 调用示例

### 读取列表（公开）

```bash
curl 'https://server.lovlin.cn/v1/share'
curl 'https://server.lovlin.cn/v1/share?limit=20&offset=0'
```

### 读取单条（公开）

```bash
curl 'https://server.lovlin.cn/v1/share/1'
```

### 新增（需 token）

```bash
curl -X POST 'https://server.lovlin.cn/v1/share' \
  -H 'Content-Type: application/json' \
  -H 'X-Share-Token: <token>' \
  -d '{"date":"2026-11-15 20:00","device":"IPhone","text":"今天天气不错","images":3,"location":"江门"}'
```

### 修改（需 token）

```bash
curl -X PUT 'https://server.lovlin.cn/v1/share/1' \
  -H 'Content-Type: application/json' \
  -H 'X-Share-Token: <token>' \
  -d '{"date":"2026-11-15 20:00","text":"修改后的内容","images":2}'
```

### 删除（需 token）

```bash
curl -X DELETE 'https://server.lovlin.cn/v1/share/1' \
  -H 'X-Share-Token: <token>'
```

## 响应

### 列表

```json
{
  "success": true,
  "total": 32,
  "data": [
    {
      "id": 1,
      "date": "2026-11-14 21:01",
      "device": "IPhone",
      "text": "大街上已经开始飘荡着糖炒栗子和烤红薯的香味了。",
      "images": 2,
      "location": "江门",
      "createdAt": 1731588060000
    }
  ]
}
```

列表按 `date` 倒序，`limit` 默认 100（上限 100），`offset` 默认 0。

## 错误响应

| 状态码 | 场景                     |
| ------ | ------------------------ |
| `400`  | `date` / `text` 缺失、无效的 id |
| `401`  | 未授权（token 错误或缺失） |
| `404`  | 分享不存在               |
| `429`  | 触发限流                 |
| `500`  | 数据库未配置 / 服务器错误 |

```json
{ "success": false, "message": "未授权" }
```
