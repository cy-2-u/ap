# webtask — 签到面板（自托管 / Docker）

NewAPI 类站点每日定时签到面板（token / session 认证），内置无头浏览器执行器应对
Cloudflare 盾（失败自动 2 小时冷却），纯直连、零外部依赖、单文件配置。

## 部署

### Docker（推荐）

```bash
docker run -d -p 7860:7860 \
  -e ACCESS_KEY=足够长的随机口令 \
  --restart unless-stopped \
  ghcr.io/cy-2-u/ap:latest
```

镜像由 GitHub Actions 自动构建（push 到 main 即重建）。

### 裸机

node 20+ → `npm install` → `node server.mjs`；配置读工作目录 `.env`（见 `.env.example`）。
Debian 11 需给 patchright 加 `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=debian12-x64`（Debian 12 无需）。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `ACCESS_KEY` | 是* | 面板口令；*未配置时启动自动生成并打印在日志（重启更换） |
| `PORT` / `BIND` | 否 | 监听端口/地址，默认 7860 / 0.0.0.0 |

## 数据

全部落在工作目录：`config.json`（账号/配置/计划）、`.profile`（浏览器指纹）、
`challenge-state.json`（冷却状态）。裸机天然持久；容器部署把工作目录挂到卷即可长期保存。

## 提醒

- 自用、低频，请遵守目标站点条款
- 仓库公开：口令只放环境变量或服务器本地 `.env`，别写进仓库
