# 标题同步接口（/v1/counter/title）

Twikoo 的 `counter` 表只在**首次**记录某个 url 时写入 `title`，之后改文章标题只会累加 `time`，管理面板里会一直显示旧标题。这个接口用来把当前页面的标题校正回去。

## 端点

| 方法   | 路径                 | 说明         | 鉴权 |
| ------ | -------------------- | ------------ | ---- |
| `POST` | `/v1/counter/title`  | 同步页面标题 | 公开 |

## 行为

- 只更新**已存在**的 `counter` 记录，不会插入新行（新页面的记录仍由 Twikoo 自己创建）
- `title` 与库里一致时不产生写入（SQL 里带 `title <> ?`）
- 同步成功会一并刷新 `updated`

## 调用示例

```bash
curl -X POST 'https://server.lovlin.cn/v1/counter/title' \
  -H 'Content-Type: application/json' \
  -d '{"url":"/posts/2024/0504","title":"分布式版本控制工具 | koizora"}'
```

前端调用：

```js
fetch('https://server.lovlin.cn/v1/counter/title', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: location.pathname, title: document.title })
})
```

## 响应

```json
{
  "success": true,
  "data": {
    "url": "/posts/2024/0504",
    "title": "分布式版本控制工具 | koizora",
    "changed": true
  }
}
```

`changed: false` 表示标题本来就一致，或该 url 还没有 counter 记录。

## 错误响应

| 状态码 | 场景                          |
| ------ | ----------------------------- |
| `400`  | url 不合法 / title 为空或超长 |
| `429`  | 触发限流                      |
| `500`  | 数据库未绑定 / 写入失败       |
