# 中韩课堂字幕器

一个面向手机和 iPad 的本机优先 PWA，用于韩语课堂实时中文字幕和课后完整中韩逐字稿保存。

## 功能

- 实时麦克风输入，使用 `gpt-realtime-translate` 做韩语到中文翻译。
- 同一会话启用 `gpt-realtime-whisper`，保存韩文源语言转录。
- 字幕器主屏以大号中文为核心，上一两句弱化显示，韩文默认隐藏。
- 课后记录保存在浏览器 IndexedDB，可导出 Markdown。
- 不保存课堂音频，不做云同步、摘要、复习卡或复杂笔记编辑。

## 本地运行

```bash
npm.cmd install
npm.cmd run dev
```

打开本机地址后，在设置里输入 OpenAI API key，允许麦克风权限，然后点击“开始”。

## 重要安全说明

当前实现按个人私用原型处理，浏览器会使用 Realtime WebSocket 的 `openai-insecure-api-key.*` 子协议连接 OpenAI。不要公开部署这个版本，也不要把 API key 提交到仓库。

更适合长期使用的版本应该增加一个轻量后端：标准 API key 只放在服务端，前端只拿短期 client secret。

## 脚本

```bash
npm.cmd run dev       # 开发服务器
npm.cmd run build     # 类型检查 + 构建
npm.cmd run test      # 单元测试
```

## VPS 部署

这个项目是纯前端 Vite PWA，不需要 Vercel。`npm.cmd run build` 会生成 `dist/`，把它作为静态文件放到 VPS 上即可。

已知 VPS 信息沿用 `Interview` 和 `connection` 项目：

- Host: `49.51.38.235`
- SSH user: `ubuntu`
- SSH key: `C:\Users\Administrator\Desktop\Projects\Siyi.pem`
- VPS Compose 路径：`/home/ubuntu/muxing`
- 建议静态文件路径：`/opt/jiahuan/dist`
- 建议本机端口：`8091`，避开已有 `8000`、`8080`、`8787`、`20241`、`40000`
- 建议域名：`jiahuan.gaid.studio` 或 `subtitle.gaid.studio`

推荐部署方式是在 VPS 现有 `/home/ubuntu/muxing/docker-compose.yml` 里加一个只监听 localhost 的静态服务，例如：

```yaml
jiahuan_web:
  image: nginx:alpine
  container_name: jiahuan_web
  restart: always
  ports:
    - "127.0.0.1:8091:80"
  volumes:
    - /opt/jiahuan/dist:/usr/share/nginx/html:ro
```

然后在 Cloudflare Tunnel 里添加 public hostname：

```text
Hostname: jiahuan.gaid.studio
Service: http://localhost:8091
```

手动部署：

```powershell
npm.cmd run test
npm.cmd run build
scp -i C:\Users\Administrator\Desktop\Projects\Siyi.pem -r dist\* ubuntu@49.51.38.235:/tmp/jiahuan-dist/
```

VPS 上执行：

```bash
sudo mkdir -p /opt/jiahuan/dist
sudo rsync -a --delete /tmp/jiahuan-dist/ /opt/jiahuan/dist/
cd /home/ubuntu/muxing
sudo docker compose up -d jiahuan_web
```

注意：当前版本仍然是在浏览器里输入 OpenAI API key，只适合私人原型。公开长期使用前，应加后端签发短期 Realtime client secret，或者至少用 Cloudflare Access 保护这个子域名。

## CI/CD 部署

本仓库已添加 GitHub Actions workflow：`.github/workflows/deploy-static.yml`。GitHub repo 是 `https://github.com/SiyiDuProjects/Jiahuan`。

workflow 会执行：

```text
npm ci
npm test
npm run build
rsync dist/ 到 VPS
修正静态文件权限
docker compose up -d jiahuan_web
curl 公网 URL
```

需要在 GitHub organization/repository secrets 里配置：

```text
SSH_HOST=49.51.38.235
SSH_PORT=22
SSH_USER=ubuntu
SSH_KEY=<Siyi.pem 的完整私钥内容>
COMPOSE_PATH=/home/ubuntu/muxing
JIAHUAN_DEPLOY_PATH=/opt/jiahuan/dist
JIAHUAN_COMPOSE_SERVICE=jiahuan_web
JIAHUAN_PUBLIC_URL=https://jiahuan.gaid.studio
```

如果最终用 `subtitle.gaid.studio`，把 `JIAHUAN_PUBLIC_URL` 改成那个域名。详细步骤见 `DEPLOY_CICD.md`。

## GitHub 连接

当前 remote 指向：

```bash
https://github.com/SiyiDuProjects/Jiahuan.git
```
