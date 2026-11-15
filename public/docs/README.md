# API 文档

## API 概览

| 模块     | 路径          | 说明                             |
| -------- | ------------- | -------------------------------- |
| 天气     | `/v1/weather` | 城市实时天气 + 7 天预报          |
| IP 查询  | `/v1/ipinfo`  | IP 地理位置及 ISP 信息           |
| 随机图片 | `/v1/img`     | 横/竖屏自适应，302/json/text/img |
| 分享     | `/v1/share`   | 日常分享（说说），D1 存储，读公开写需 token |

查看所有端点：`GET /v1/meta`

## 通用约定

**基础 URL**：`https://server.lovlin.cn`

**响应格式**：JSON

**限流**：每 IP 100 次 / 60 秒，超出返回 `429`。

## 快速调用

```bash
# 北京天气
curl 'https://server.lovlin.cn/v1/weather?city=北京'

# 查询当前 IP 信息
curl https://server.lovlin.cn/v1/ipinfo

# 随机一张图片（302 跳转）
curl -L https://server.lovlin.cn/v1/img
```

## 详细文档

- [天气](weather.md)
- [IP 查询](ipinfo.md)
- [随机图片](img.md)
- [分享](share.md)
