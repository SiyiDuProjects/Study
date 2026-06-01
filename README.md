# 中韩课堂字幕器

React + Vite + TypeScript PWA，用于韩语课堂实时中文字幕、韩文转录保存、按课程归档，以及复制/导出课堂上下文。

## 功能

- 默认使用实时转录 + 翻译模式：浏览器用服务端签发的短期 client secret 建立 OpenAI Realtime 转录会话，服务端 VAD 低延迟切分韩语，韩文先流式显示，再按句调用服务端文本翻译补中文副行。
- 保留实时直译 WebSocket 模式和官方 WebRTC 翻译模式，用于网络兼容性 fallback 和质量对照。
- 远距离收音增强保留为本机设置开关，默认关闭；只有课堂音量明显偏低时再手动开启，避免放大环境噪声影响转录。
- API key 只放在服务器，浏览器通过 `/api/realtime/client-secret` 获取短期 Realtime client secret。
- 录音前必须选择课程，也可以选择 `日常 / 不选课程`。
- 课后记录保存到服务器 SQLite，同一个受保护网站下的不同设备都能看到同一批记录。
- 资料库按课程整理历史课次，可一键复制单节课或整门课当前已保存的中韩转录给 AI。
- 保存服务器失败时，记录会先进入本机 IndexedDB 待同步队列，服务器恢复后自动重试。
- 不保存、不上传到本项目服务器持久化原始课堂音频；只保存文本 transcript 和课堂元数据。

## 本地运行

```powershell
npm.cmd install
$env:OPENAI_API_KEY="sk-..."
npm.cmd run dev
```

打开 Vite 地址后，在首页选择课程或日常，点击“开始录音”，再允许麦克风权限。

## 脚本

```powershell
npm.cmd run dev          # 同时启动 Express API 和 Vite
npm.cmd run test         # Vitest
npm.cmd run build        # TypeScript + Vite 生产构建
npm.cmd run server:start # 运行已构建的 Express 服务
npm.cmd run smoke:openai # 手动验证 OpenAI client secret 和文本翻译配置
```

## 服务端环境变量

```text
OPENAI_API_KEY=服务器端 OpenAI API key
PORT=3001
JIAHUAN_DB_PATH=/data/jiahuan.sqlite
JIAHUAN_STATIC_DIR=/app/dist
OPENAI_REALTIME_TRANSLATION_MODEL=gpt-realtime-translate
OPENAI_REALTIME_TRANSCRIPTION_MODEL=gpt-realtime-whisper
OPENAI_TEXT_TRANSLATION_MODEL=gpt-5.4-mini
OPENAI_TEXT_TRANSLATION_MODELS=gpt-5.4-mini,gpt-5.4-nano
```

生产环境通过 Cloudflare Access 保护站点入口；应用内不实现账号系统。
模型名由服务端环境变量集中配置，浏览器 UI 从 `/api/config` 获取可选模型。浏览器不保存、不输入 OpenAI 主 API key。

## VPS 部署

这台 Mac 可用共享私钥登录现有 VPS：

```bash
ssh -i /Users/bytedance/Projects/keys/connection-prod-20260526.pem ubuntu@49.51.38.235
```

私钥在多个本地项目间共用，不要提交、打印或粘贴私钥内容。权限异常时：

```bash
chmod 700 /Users/bytedance/Projects/keys
chmod 600 /Users/bytedance/Projects/keys/connection-prod-20260526.pem
```

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
    OPENAI_REALTIME_TRANSCRIPTION_MODEL: gpt-realtime-whisper
    OPENAI_TEXT_TRANSLATION_MODELS: gpt-5.4-mini,gpt-5.4-nano
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
