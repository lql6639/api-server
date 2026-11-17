# Twikoo评论接口（/v1/comment）

评论管理接口。**读列表直连 Twikoo 的 D1（快），改/删转发 Twikoo 事件接口（保留其 XSS 消毒、垃圾检测等逻辑）**。

不提供「发新评论」接口——发评论请继续走 Twikoo 前端（文章页下方评论区）。

## 端点

| 方法     | 路径                | 说明                     | 鉴权  |
| -------- | ------------------- | ------------------------ | ----- |
| `GET`    | `/v1/comment`       | 评论列表                 | 公开  |
| `GET`    | `/v1/comment/:id`   | 单条评论                 | 公开  |
| `PUT`    | `/v1/comment/:id`   | 修改评论                 | token |
| `DELETE` | `/v1/comment/:id`   | 删除评论                 | token |
| `PUT`    | `/v1/comment/counter` | 校正 counter 表页面标题 | token |

## 鉴权

修改 / 删除需要在请求头携带 token：

```
X-Twikoo-Key: <token>
```

也可以在 URL 上传 `?token=<token>`（请求头优先）。token 通过 `wrangler secret put TWIKOO_KEY` 配置。

写操作会转发到 Twikoo，内部用 `TWIKOO_ADMIN_TOKEN`（= `md5(Twikoo 管理密码)`）作为管理员 accessToken 完成鉴权。

## 数据字段

| 字段      | 类型    | 说明               |
| --------- | ------- | ------------------ |
| `id`      | string  | 评论 id（`_id`）   |
| `nick`    | string  | 昵称               |
| `comment` | string  | 评论内容           |
| `url`     | string  | 所属页面路径       |
| `link`    | string  | 评论者网址         |
| `avatar`  | string  | 头像地址           |
| `isSpam`  | boolean | 是否垃圾评论       |
| `master`  | boolean | 是否博主           |
| `top`     | boolean | 是否置顶           |
| `like`    | array   | 点赞列表           |
| `created` | number  | 创建时间戳（毫秒） |
| `updated` | number  | 更新时间戳（毫秒） |

> 出于隐私保护，`ip`、`mail`、`ua` 等敏感字段不对外返回。

## 调用示例

### 读取列表（公开）

```bash
# 全部评论
curl 'https://server.lovlin.cn/v1/comment'

# 某篇文章的评论
curl 'https://server.lovlin.cn/v1/comment?url=/posts/xxx'

# 分页
curl 'https://server.lovlin.cn/v1/comment?limit=50&offset=0'
```

### 读取单条（公开）

```bash
curl 'https://server.lovlin.cn/v1/comment/xxxxxxxx'
```

### 修改评论（需 token，转发 Twikoo）

```bash
curl -X PUT 'https://server.lovlin.cn/v1/comment/xxxxxxxx'
  -H 'Content-Type: application/json'
  -H 'X-Twikoo-Key: <token>'
  -d '{"set":{"comment":"修改后的评论内容"}}'
```

`set` 字段会原样传给 Twikoo 的 `COMMENT_SET_FOR_ADMIN`，支持部分更新（如 `nick`、`comment`、`top` 等）。

### 删除评论（需 token，转发 Twikoo）

```bash
curl -X DELETE 'https://server.lovlin.cn/v1/comment/xxxxxxxx'
  -H 'X-Twikoo-Key: <token>'
```

## 响应

### 列表

```json
{
  "success": true,
  "total": 10,
  "data": [
    {
      "id": "xxxxxxxx",
      "nick": "匿名",
      "comment": "写得真好",
      "url": "/posts/xxx",
      "created": 1731672000000
    }
  ]
}
```

列表按 `created` 倒序，只返回非垃圾评论（`isSpam = 0`）。

## 校正页面标题（counter 表）

Twikoo 的 `counter` 表只在**首次**记录某个 url 时写入 `title`，之后改文章标题它不会更新，管理面板里会一直显示旧标题。这个接口直接改它库里的标题，不动 `time`。

单条：

```bash
curl -X PUT 'https://server.lovlin.cn/v1/comment/counter' \
  -H 'Content-Type: application/json' \
  -H 'X-Twikoo-Key: <token>' \
  -d '{"url":"/posts/2024/0504","title":"分布式版本控制工具 | koizora"}'
```

批量（改完多篇标题时一次同步，上限 200 条）：

```bash
curl -X PUT 'https://server.lovlin.cn/v1/comment/counter' \
  -H 'Content-Type: application/json' \
  -H 'X-Twikoo-Key: <token>' \
  -d '{"items":[
        {"url":"/posts/2024/0504","title":"分布式版本控制工具 | koizora"},
        {"url":"/posts/2024/0801","title":"开源关系型数据库管理系统 | koizora"}
      ]}'
```

```json
{
  "success": true,
  "data": { "total": 2, "changed": 1, "unchanged": 1 }
}
```

只更新已存在的记录，不会插入新行；标题与库里一致时不产生写入（SQL 里带 `title <> ?`）。

## 错误响应

| 状态码 | 场景                       |
| ------ | -------------------------- |
| `400`  | 无效的 id、`set` 为空、url/title 不合法 |
| `401`  | 未授权（token 错误或缺失） |
| `404`  | 评论不存在                 |
| `429`  | 触发限流                   |
| `500`  | 数据库未配置 / 转发失败    |

```json
{ "success": false, "message": "未授权" }
```
