# 心愿树洞接口（/v1/wishes）

心情树洞（心愿 / 树洞），数据存 Cloudflare D1 数据库。**读公开、发布（POST）公开、修改/删除需 token 鉴权**。

## 端点

| 方法     | 路径             | 说明     | 鉴权  |
| -------- | ---------------- | -------- | ----- |
| `GET`    | `/v1/wishes`     | 心愿列表 | 公开  |
| `GET`    | `/v1/wishes/:id` | 单条心愿 | 公开  |
| `POST`   | `/v1/wishes`     | 发布心愿 | 公开  |
| `PUT`    | `/v1/wishes/:id` | 修改心愿 | token |
| `DELETE` | `/v1/wishes/:id` | 删除心愿 | token |

## 鉴权

修改 / 删除需要在请求头携带 token：

```
X-Wishes-Token: <token>
```

也可以在 URL 上传 `?token=<token>`（请求头优先）。token 通过 `wrangler secret put WISHES_TOKEN` 配置。

发布（POST）**不需要** token，任何访客都能发布心愿 / 树洞。

## 数据字段

| 字段        | 类型   | 说明                                       |
| ----------- | ------ | ------------------------------------------ |
| `id`        | number | 自增主键                                   |
| `content`   | string | 内容（最多 50 字）                         |
| `nickname`  | string | 昵称（最多 10 字，空则「匿名」）           |
| `color`     | string | 颜色：blue/pink/green/orange/yellow/purple |
| `type`      | string | `wish`（心愿）或 `treehole`（树洞）        |
| `date`      | string | 日期，如 `2026/11/14`                      |

## 调用示例

### 读取列表（公开）

```bash
curl 'https://server.lovlin.cn/v1/wishes'
curl 'https://server.lovlin.cn/v1/wishes?type=wish'
curl 'https://server.lovlin.cn/v1/wishes?type=treehole&limit=50&offset=0'
```

### 读取单条（公开）

```bash
curl 'https://server.lovlin.cn/v1/wishes/1'
```

### 发布（公开，无需 token）

```bash
curl -X POST 'https://server.lovlin.cn/v1/wishes'
  -H 'Content-Type: application/json'
  -d '{"content":"愿家人身体健康","nickname":"阿橘","color":"yellow","type":"wish","date":"2026/11/06"}'
```

### 修改（需 token）

```bash
curl -X PUT 'https://server.lovlin.cn/v1/wishes/1'
  -H 'Content-Type: application/json'
  -H 'X-Wishes-Token: <token>'
  -d '{"content":"修改后的内容","color":"pink","type":"treehole"}'
```

### 删除（需 token）

```bash
curl -X DELETE 'https://server.lovlin.cn/v1/wishes/1'
  -H 'X-Wishes-Token: <token>'
```

## 响应

### 列表

```json
{
  "success": true,
  "total": 14,
  "data": [
    {
      "id": 1,
      "content": "愿家人身体健康",
      "nickname": "阿橘",
      "color": "yellow",
      "type": "wish",
      "date": "2026/11/06"
    }
  ]
}
```

列表按 `date` 倒序（新的在前），同一天的两条按 `id` 倒序；`limit` 默认 200（上限 200），`offset` 默认 0，`type` 可选过滤。

## 错误响应

| 状态码 | 场景                                |
| ------ | ----------------------------------- |
| `400`  | `content` 缺失、超长、无效的 id     |
| `401`  | 未授权（token 错误或缺失，仅改/删） |
| `404`  | 心愿不存在                          |
| `429`  | 触发限流                            |
| `500`  | 数据库未配置 / 服务器错误           |

```json
{ "success": false, "message": "未授权" }
```
