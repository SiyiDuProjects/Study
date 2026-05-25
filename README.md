# 中韩课堂字幕器

React + Vite + TypeScript PWA，用于韩语课堂实时中文字幕、韩文转录保存，以及按课程归档本地 Markdown 导出。

## 功能

- 实时麦克风输入，默认使用 `gpt-realtime-translate` 做韩语到中文翻译，并保存韩文源语言转录。
- API key 只放在服务器，浏览器通过 `/api/realtime/client-secret` 获取短期 Realtime client secret。
- 录音前必须选择课程，也可以选择 `日常 / 不选课程`。
- 课后记录保存到服务器 SQLite，同一个受保护网站下的不同设备都能看到同一批记录。
- 不保存、不上传到本项目服务器持久化原始课堂音频；只保存文本 transcript 和课堂元数据。

## 本地运行

```powershell
npm.cmd install
$env:OPENAI_API_KEY="sk-..."
npm.cmd run dev
```

打开 Vite 地址后，允许麦克风权限，选择课程或日常，然后点击开始。

## 脚本

```powershell
npm.cmd run dev          # 同时启动 Express API 和 Vite
npm.cmd run test         # Vitest
npm.cmd run build        # TypeScript + Vite 生产构建
npm.cmd run server:start # 运行已构建的 Express 服务
```

## 服务端环境变量

```text
OPENAI_API_KEY=服务器端 OpenAI API key
PORT=3001
JIAHUAN_DB_PATH=/data/jiahuan.sqlite
JIAHUAN_STATIC_DIR=/app/dist
```

生产环境通过 Cloudflare Access 保护站点入口；应用内不实现账号系统。

## VPS 部署

推荐在现有 VPS `/home/ubuntu/muxing/docker-compose.yml` 中使用一个 Node 容器同时服务静态前端和 `/api`：

```yaml
jiahuan_app:
  image: node:22-bookworm-slim
  container_name: jiahuan_app
  restart: always
  working_dir: /app
  command: ["node", "dist-server/server/index.js"]
  ports:
    - "127.0.0.1:8091:80"
  environment:
    NODE_ENV: production
    PORT: "80"
    JIAHUAN_DB_PATH: /data/jiahuan.sqlite
    JIAHUAN_STATIC_DIR: /app/dist
  env_file:
    - /home/ubuntu/muxing/jiahuan.env
  volumes:
    - /opt/jiahuan/app:/app:ro
    - /opt/jiahuan/data:/data
```

`/home/ubuntu/muxing/jiahuan.env` 只放在 VPS：

```text
OPENAI_API_KEY=sk-...
```

Cloudflare Tunnel public hostname 继续指向：

```text
http://localhost:8091
```

GitHub remote: `https://github.com/SiyiDuProjects/Jiahuan.git`.
