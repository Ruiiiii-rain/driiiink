# 喝了么 · 公网部署指南

> 面向"给所有人用的正式网站"。改造已完成部分：SQLite 存储（旧数据自动迁移）、账号密码注册/登录、token 过期、注册/登录限流。本文件教你把它跑到公网。

## 1. 环境要求

- Node.js **≥ 22.5**（存储使用内置 `node:sqlite`），推荐 **Node 24 LTS**
- 验证：`node -e "require('node:sqlite'); console.log('ok')"`
- 零第三方依赖（无需 npm install）

## 2. 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | 监听端口 |
| `DATA_FILE` | `data/data.db` | SQLite 数据库路径 |
| `LEGACY_JSON` | `data/data.json` | 旧版 JSON（存在且库不存在时自动导入一次） |
| `TOKEN_TTL_MS` | 30 天 | 登录 token 有效期 |
| `AUTH_RATE_PER_HOUR` | 30 | 每 IP 每小时注册/登录尝试上限 |
| `REGISTER_DAILY` | 300 | 全局每日新账号上限 |
| `REMIND_COOLDOWN_MS` / `REMIND_JUST_DRANK_MS` / `REMIND_DAILY_LIMIT` | 10min/15min/8 | 防打扰规则 |
| `TRUST_PROXY` | 关 | 部署在反代后且反代设置 X-Forwarded-For 时置 1（限流按真实 IP） |

> 默认已假定反代不可信；开启 `TRUST_PROXY=1` 前请确保只有你的反代能连到应用端口（建议防火墙只放行 80/443）。

## 3. 服务器部署（Ubuntu 示例）

```bash
# 1) 安装 Node 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2) 上传项目（如 /opt/heleme），进入目录
cd /opt/heleme

# 3) 进程守护
sudo npm i -g pm2
pm2 start server.js --name heleme
pm2 save && pm2 startup   # 开机自启

# 4) HTTPS 反向代理（Caddy 自动证书，需域名解析到本机）
```

```caddyfile
# /etc/caddy/Caddyfile
heleme.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo apt-get install -y caddy
sudo systemctl restart caddy
```

## 4. 域名与备案（中国大陆）

- 用国内服务器 + 域名 → **必须 ICP 备案**（1~2 周），备案期间无法用 80/443 提供服务；
- 想跳过备案：用**香港/海外轻量服务器**（延迟略高，个人小应用可接受）；
- 域名建议注册 `.cn/.com` 任一；备案在服务器商控制台提交（如腾讯云/阿里云）。

## 5. 备份（重要）

SQLite 数据在 `data/data.db`（含 `-wal/-shm` 临时文件）。备份方式：

```bash
# 建议每日定时（crontab），使用 sqlite3 在线备份（一致快照）
sqlite3 data/data.db ".backup '/backup/heleme-$(date +%F).db'"
```

升级代码前先备份一次。回滚 = 停服 → 换回备份文件 → 启动。

## 6. 常用运维

```bash
pm2 logs heleme        # 看日志
pm2 restart heleme     # 重启
pm2 stop heleme        # 停止
```

## 7. 旧版数据迁移说明

- 首次启动会自动把旧版 `data/data.json`（若有）导入 SQLite 并改名留档（`data.json.migrated-<时间戳>`）；
- 旧版账号**没有密码**，登录会被提示"用新昵称重新注册"——原设备上仍有效的 token 会继续可用 30 天，建议新老交替期重新注册一次；
- 已归档的测试数据在 `data/data.测试数据归档-*.json`，不需要可删除。

## 8. 安全清单（上线前过一遍）

- [ ] HTTPS 已生效（Caddy/证书）
- [ ] 防火墙只放行 80/443（应用端口 3000 不对外）
- [ ] `TRUST_PROXY` 设置正确
- [ ] 每日备份任务已配置
- [ ] 默认规则（冷却/限流）未被关掉；临时测试用的宽松规则勿用于生产
