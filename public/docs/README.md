# API 文档

## API 概览

| 模块     | 路径          | 说明                                                 |
| -------- | ------------- | ---------------------------------------------------- |
| IP 查询  | `/v1/ipinfo`  | IP 地理位置及 ISP 信息                               |
| 天气     | `/v1/weather` | 城市实时天气 + 7 天预报                              |
| 随机图片 | `/v1/img`     | 横/竖屏自适应，302/json/text/img                     |
| 分享     | `/v1/share`   | 日常分享（说说），D1 存储，读公开写需 token          |
| 心愿树洞 | `/v1/wishes`  | 心情树洞（心愿/树洞），D1 存储，发布公开改删需 token |
| 评论     | `/v1/comment` | 评论管理，读 D1 存储、改删转发 Twikoo                |
| 站点统计 | `/v1/stats`   | PV / UV 统计，D1 存储，读写公开                      |

查看所有端点：`GET /v1/meta`

## 通用约定

**基础 URL**：`https://server.lovlin.cn`

**响应格式**：JSON

**限流**：每 IP 100 次 / 60 秒，超出返回 `429`。

## 快速调用

```bash
# 查询当前 IP 信息
curl https://server.lovlin.cn/v1/ipinfo

# 查询当前 IP 实时天气
curl 'https://server.lovlin.cn/v1/weather/realtime'

# 随机一张图片（302 跳转）
curl -L https://server.lovlin.cn/v1/img

# 日常分享
curl 'https://server.lovlin.cn/v1/share'

# 心愿树洞
curl 'https://server.lovlin.cn/v1/wishes'

# 评论列表
curl 'https://server.lovlin.cn/v1/comment'

# 站点统计
curl 'https://server.lovlin.cn/v1/stats'
```

## 详细文档

- [IP 查询](ipinfo.md)
- [天气](weather.md)
- [随机图片](img.md)
- [分享](share.md)
- [心愿](wishes.md)
- [评论](comment.md)
- [站点统计](stats.md)
