# CI/CD 零停机部署

基于 `webhook` + `PM2` 的零停机部署方案，不依赖 GitHub Actions。

## 文件清单

| 文件                         | 说明                                          |
| ---------------------------- | --------------------------------------------- |
| `ecosystem.config.js`        | PM2 配置（cluster 模式、max 进程数）          |
| `deploy.sh`                  | 部署脚本（拉取代码、按需安装依赖、reload）    |
| `webhook.example.json`       | webhook 配置模板（需改名为 `webhook.json`）   |
| `server-config.example.json` | 服务配置模板（需改名为 `server-config.json`） |

## 步骤

### 1. 环境准备

```bash
# 安装 PM2
npm install -g pm2

# 下载 webhook（二进制文件）
sudo curl -L -o /tmp/webhook-linux-amd64.tar.gz \
  https://github.com/adnanh/webhook/releases/download/2.8.2/webhook-linux-amd64.tar.gz
sudo tar -xzf /tmp/webhook-linux-amd64.tar.gz -C /tmp/
sudo mv /tmp/webhook-linux-amd64/webhook /usr/local/bin/webhook
sudo chmod +x /usr/local/bin/webhook
```

### 2. 首次部署

```bash
cd /opt
git clone https://github.com/FrecklyComb1728/api-server.git
cd api-server

# 创建运行用户并授权项目目录
sudo useradd --system --create-home --shell /bin/bash api-server
sudo chown -R api-server:api-server /opt/api-server

# 从示例文件创建实际配置
cp server-config.example.json server-config.json && cp ecosystem.config.example.js ecosystem.config.js

# 编辑 server-config.json 和 ecosystem.config.js 调整配置
sudo -u api-server npm ci --registry=https://registry.npmmirror.com
sudo -u api-server pm2 start ecosystem.config.js
sudo -u api-server pm2 save
pm2 startup -u api-server --hp /home/api-server
```

### 3. 部署脚本

`deploy.sh` 已包含在项目中，功能：

- `flock` 原子锁防并发部署；锁被占用时排队等待，前一个实例完成后接管
- `git fetch` 后比较远程 HEAD 与本地 HEAD，无变更时跳过
- 部署期间若有新 push，循环追赶最新代码（最多 5 轮），排队实例可继续接管，避免并发触发导致漏部署
- `package.json`、`package-lock.json` 任一变动时重新 `npm ci`
- `pm2 reload` 零停机重启

设置权限：

```bash
chmod +x /opt/api-server/deploy.sh
```

### 4. Webhook 配置

```bash
cd /opt/api-server
cp webhook.example.json webhook.json
```

生成随机 secret：

```bash
openssl rand -hex 32
```

将输出填入 `webhook.json` 的 `secret` 字段。

### 5. 系统服务

创建 `/etc/systemd/system/webhook.service`：

```ini
[Unit]
Description=Webhook for API Server Deploy
After=network.target

[Service]
Type=simple
User=api-server
Group=api-server
WorkingDirectory=/opt/api-server
ExecStart=/usr/local/bin/webhook \
  -hooks /opt/api-server/webhook.json \
  -port 9000
Restart=always
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/opt/api-server

[Install]
WantedBy=multi-user.target
```

如果需要更改 URL 前缀（如 `/webhook`），请在 `ExecStart` 中添加 `-urlprefix "/webhook"`。

```ini
  -urlprefix "/webhook"
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable webhook
sudo systemctl start webhook
sudo systemctl status webhook
```

### 6. 开放端口

```bash
# ufw
sudo ufw allow 9000/tcp

# 或仅允许 GitHub IP 段
sudo ufw allow from 140.82.112.0/20 to any port 9000 proto tcp

# 云服务器需在安全组放行 9000 端口
```

### 7. GitHub Webhook

仓库 → Settings → Webhooks → Add webhook：

| 字段         | 值                                      |
| ------------ | --------------------------------------- |
| Payload URL  | `http://服务器IP:9000/hooks/api-server` |
| Content type | `application/json`                      |
| Secret       | 与 `webhook.json` 一致                  |
| Events       | Just the `push` event                   |

### 8. 验证

```bash
# webhook 日志
sudo journalctl -u webhook -f

# PM2 状态
pm2 status

# 部署日志
tail -f /opt/api-server/logs/deploy.log
```

### 9. 本机反向代理

服务默认只监听 `127.0.0.1:8633`。在同一台主机配置 nginx，并覆盖外部请求携带的转发头：

```nginx
location / {
    proxy_pass http://127.0.0.1:8633;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
}
```

不要把 Node.js 的 8633 端口直接暴露到公网。

---

## 内地服务器优化

### npm 加速

部署脚本已配置 `--registry=https://registry.npmmirror.com`。

### Git 加速

```bash
git config --global url."https://gh.1s.fan/".insteadOf https://github.com/
```

### 代理

如有 HTTP 代理：

```bash
git config --global http.proxy http://127.0.0.1:7890
git config --global https.proxy http://127.0.0.1:7890
```

---

## 故障排查

| 问题            | 检查                                                       |
| --------------- | ---------------------------------------------------------- |
| webhook 不触发  | `journalctl -u webhook -f`，检查端口开放和 GitHub IP 可达  |
| 部署失败        | `cat logs/deploy.log`，确认 git fetch 成功、权限正确       |
| PM2 reload 失败 | `pm2 logs mifeng-api-server`，确认 `server.js` 正常 listen |
| 端口 9000 不通  | 云服务商安全组是否放行                                     |
