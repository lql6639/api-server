# API 文档

## API 概览

| 模块     | 路径          | 说明                             |
| -------- | ------------- | -------------------------------- |
| 随机图片 | `/v1/img`     | 横/竖屏自适应，302/json/text/img |
| IP 查询  | `/v1/ipinfo`  | IP 地理位置及 ISP 信息           |
| 天气     | `/v1/weather` | 城市实时天气 + 7 天预报          |

查看所有端点：`GET /v1/meta`

## 通用约定

**基础 URL**：`https://api.lovlin.eu.cc`

**响应格式**：JSON

**限流**：每 IP 100 次 / 60 秒，超出返回 `429`。

## 快速调用

```bash
# 随机一张图片（302 跳转）
curl -L https://api.lovlin.eu.cc/v1/img

# 查询当前 IP 信息
curl https://api.lovlin.eu.cc/v1/ipinfo

# 北京天气
curl 'https://api.lovlin.eu.cc/v1/weather?city=北京'
```

## 详细文档

- [随机图片](img.md)
- [IP 查询](ipinfo.md)
- [天气](weather.md)
