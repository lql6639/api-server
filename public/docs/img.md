# 随机图片接口（/v1/img）

## 端点

| 方法  | 路径             | 说明                         |
| ----- | ---------------- | ---------------------------- |
| `GET` | `/v1/img`        | 随机一张（UA 自适应横/竖屏） |
| `GET` | `/v1/img/h`      | 随机一张（强制横屏）         |
| `GET` | `/v1/img/v`      | 随机一张（强制竖屏）         |
| `GET` | `/v1/img/list`   | 图片列表（UA 自适应）        |
| `GET` | `/v1/img/list/h` | 图片列表（强制横屏）         |
| `GET` | `/v1/img/list/v` | 图片列表（强制竖屏）         |

| 参数   | 类型   | 默认  | 说明                                      |
| ------ | ------ | ----- | ----------------------------------------- |
| `type` | string | `302` | 返回格式：`302` / `json` / `text` / `img` |

---

## 302 重定向

```bash
curl -L https://server.lovlin.cn/v1/img
```

响应：`302 Found` → `Location: https://t.alcy.cc/pc`（横屏）/ `https://t.alcy.cc/mp`（竖屏）

## JSON

```bash
curl https://server.lovlin.cn/v1/img?type=json
```

```json
{
  "status": "success",
  "time": 1730000000000,
  "data": {
    "id": "1",
    "name": "pc",
    "url": "https://t.alcy.cc/pc",
    "path": "/pc",
    "fullUrl": "https://t.alcy.cc/pc"
  }
}
```

| 字段           | 类型   | 说明                          |
| -------------- | ------ | ----------------------------- |
| `data.id`      | string | 序号                          |
| `data.name`    | string | 上游标识（pc / mp）           |
| `data.url`     | string | 基础 URL（直出模式为上游地址）|
| `data.path`    | string | 图片路径                      |
| `data.fullUrl` | string | 完整图片 URL                  |

## 纯文本

```bash
curl https://server.lovlin.cn/v1/img?type=text
```

```js
https://t.alcy.cc/pc
```

## 图片流

```bash
curl https://server.lovlin.cn/v1/img?type=img -o img.png
```

---

## 图片列表

```bash
curl https://server.lovlin.cn/v1/img/list?type=json
```

```json
{
  "status": "success",
  "total": 3,
  "time": 1730000000000,
  "data": [
    {
      "id": "1",
      "name": "100066591_p0.png",
      "url": "https://server.lovlin.cn/image",
      "path": "/background/100066591_p0.png"
    }
  ]
}
```

```bash
curl https://server.lovlin.cn/v1/img/list?type=text
```

```js
https://server.lovlin.cn/image/background/100066591_p0.png
https://server.lovlin.cn/image/background/100257227_p0.png
```

---

## UA 规则

命中任一关键词判定为竖屏，否则横屏：

`Mobile` `Android` `iPhone` `iPad` `iPod` `HarmonyOS` `Windows Phone`

---

## 错误响应

| 状态码 | 场景                       |
| ------ | -------------------------- |
| `400`  | `type` 值不合法            |
| `502`  | 上游请求失败或图片列表为空 |
| `429`  | 触发限流                   |

```json
{ "status": "error", "time": 1730000000000, "message": "未获取到图片列表" }
```
