# 天气接口（/v1/weather）

## 端点

| 方法  | 路径                   | 说明                        |
| ----- | ---------------------- | --------------------------- |
| `GET` | `/v1/weather`          | 综合查询（实时 + 7 天预报） |
| `GET` | `/v1/weather/realtime` | 仅实时天气                  |
| `GET` | `/v1/weather/week`     | 仅 7 天预报                 |

## 参数

| 参数   | 类型   | 说明                        |
| ------ | ------ | --------------------------- |
| `city` | string | 城市名称，如 `北京`、`上海` |
| `ip`   | string | 根据 IP 自动定位城市        |

`city` 和 `ip` 都不传时，使用请求来源 IP 定位。

## 调用示例

```bash
curl 'https://api.lovlin.eu.cc/v1/weather'
curl 'https://api.lovlin.eu.cc/v1/weather?city=北京'
curl 'https://api.lovlin.eu.cc/v1/weather/realtime?city=上海'
```

## 响应

### 综合查询

```json
{
  "ip": "1.2.3.4",
  "city": "北京",
  "realtime": {
    "city": "北京",
    "high": "",
    "low": "",
    "temperature": "3",
    "weather": "阴",
    "wind": "西北风",
    "windSpeed": "3级",
    "visibility": "30km",
    "humidity": "44%",
    "time": "04:13:49",
    "date": "2025/12/20"
  },
  "week": [
    {
      "date": "2025/12/20",
      "wind": "北风",
      "windSpeed": "微风",
      "weather": "中雨转小雨",
      "temperature": "9℃",
      "week": "星期六"
    }
  ]
}
```

### 实时天气字段

| 字段          | 说明                             |
| ------------- | -------------------------------- |
| `high`        | 最高温度，上游未提供时为空字符串 |
| `low`         | 最低温度，上游未提供时为空字符串 |
| `temperature` | 当前温度                         |
| `weather`     | 天气状况                         |
| `wind`        | 风向                             |
| `windSpeed`   | 风力                             |
| `visibility`  | 能见度                           |
| `humidity`    | 湿度                             |
| `time`        | 更新时间                         |
| `date`        | 日期                             |

### 7 天预报字段

| 字段          | 说明     |
| ------------- | -------- |
| `date`        | 日期     |
| `week`        | 星期     |
| `weather`     | 天气     |
| `temperature` | 温度范围 |
| `wind`        | 风向     |
| `windSpeed`   | 风力     |

## 错误响应

| 状态码 | 场景           |
| ------ | -------------- |
| `400`  | 未找到匹配城市 |
| `500`  | 上游接口不可用 |
| `429`  | 触发限流       |

```json
{ "error": "无法将城市名匹配到 cityid" }
```
