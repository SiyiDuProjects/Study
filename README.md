# 中韩课堂字幕器

React + Vite + TypeScript PWA，用于韩语课堂实时中文字幕、韩文转录保存、按课程归档，以及复制/导出课堂上下文。

## 功能

- 默认使用实时转录 + 翻译模式：浏览器用服务端签发的短期 client secret 建立 OpenAI Realtime 转录会话，使用 Realtime transcription 默认 VAD 切分韩语，韩文先流式显示，再按韩文句末标点调用服务端文本翻译补中文副行。
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
npm.cmd run sites:dev    # Sites/Worker + 本地 D1 开发环境
npm.cmd run sites:build  # 生成 Sites 托管产物
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
`OPENAI_API_KEY` 必须支持 OpenAI Realtime client secrets；只支持文字模型的中转 API 只能用于文本翻译，不能启动实时录音转录。

## OpenAI Sites

Sites 作为与现有 VPS 并行的部署路径，不替换本地 React/PWA、现有 `npm run build` 或 VPS 自动发布：

- `worker/index.ts` 提供 Worker 版 `/api`，保持课程、模型配置、实时 client secret、翻译和课堂记录接口不变。
- `worker/db.ts` 使用 Sites 注入的 D1 `DB` 绑定保存课堂记录；表结构和迁移位于 `db/schema.ts`、`drizzle/`。
- `.openai/hosting.json` 只保存 Sites 项目标识和逻辑绑定，不保存密钥或真实数据库标识。
- Sites 运行时的 `OPENAI_API_KEY` 必须在 Sites 环境设置中配置为 secret；模型变量可按上方同名变量配置。
- 本地 Sites 开发可按 `.dev.vars.example` 创建未提交的 `.dev.vars`，填入服务端配置后运行 `npm run sites:dev`；启动脚本会先把 `drizzle/` 迁移应用到本地 D1。
- Sites D1 与 VPS SQLite 是两个独立数据源。切换正式入口前，应先迁移现有课堂记录并核对数量和内容。
- GitHub Actions 会对同一个 `main` 提交分别执行 VPS 构建和 Sites 构建；两项都通过后才继续自动发布 VPS。Sites 版本仍由 Sites 使用同一提交单独私有发布。

验证 Sites 产物：

```bash
npm test
npm run sites:build
```

最终产物包含 `dist/server/index.js`、静态前端、Sites metadata 和 D1 migration，可由 Sites 版本发布流程直接使用。

## Realtime 修改纪律

- 默认课堂链路是 `transcribe-then-translate`：OpenAI Realtime 只负责韩文转录，服务器 `/api/translate` 在韩文段落已经出现后补中文。
- 韩文转录、中文翻译、字幕渲染必须分层处理。中文翻译失败、延迟或未返回时，不能阻塞后续韩文字幕继续显示。
- Realtime 模型名只能来自服务端配置和 `/api/config`，不能在浏览器代码或临时修复里偷换模型。
- 修 Realtime 问题时先检查 client secret session、VAD/event、WebRTC/audio 输入链路。不要用 UI 定时器、localStorage 版本重置、强制 fallback 模式或翻译兜底来掩盖主链路故障。
- `transcribe-then-translate` 的 transcription client-secret session 不显式设置 `turn_detection`；当前 `gpt-realtime-whisper` 真实 API 会拒绝该字段，Realtime transcription 默认 VAD 继续负责提交转录片段。
- 临时诊断只能帮助定位问题，不能变成生产控制流；修复后要能明确删除或隔离。

## VPS 部署

这台 Mac 的共享 VPS SSH 入口、私钥路径、权限修复和保密规则见 `/Users/bytedance/.codex/AGENTS.md`。

推荐在现有 VPS `/home/ubuntu/siyi/docker-compose.yml` 中使用一个 Node 容器同时服务静态前端和 `/api`：

```yaml
jiahuan_web:
  image: node:22-bookworm-slim
  container_name: jiahuan_web
  restart: always
  working_dir: /app
  command: npm run server:start
  ports:
    - "127.0.0.1:8091:3000"
  environment:
    NODE_ENV: production
    PORT: "3000"
    JIAHUAN_DB_PATH: /data/jiahuan.sqlite
    JIAHUAN_STATIC_DIR: /app/dist
    OPENAI_REALTIME_TRANSCRIPTION_MODEL: gpt-realtime-whisper
    OPENAI_TEXT_TRANSLATION_MODELS: gpt-5.4-mini,gpt-5.4-nano
  env_file:
    - /home/ubuntu/siyi/jiahuan.env
  volumes:
    - /opt/jiahuan/app:/app:ro
    - /opt/jiahuan/data:/data
```

`/home/ubuntu/siyi/jiahuan.env` 只放在 VPS：

```text
OPENAI_API_KEY=sk-...
```

这里需要放支持 OpenAI Realtime 的服务端 key。只支持 `gpt-5.4-mini`、`gpt-5.4-nano` 这类文字模型的 API 不能用于“开始录音”。

Cloudflare Tunnel public hostname 继续指向：

```text
http://localhost:8091
```

GitHub remote: `https://github.com/SiyiDuProjects/Jiahuan.git`.
