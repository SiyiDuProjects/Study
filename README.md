# Study Lecture

Study Lecture 是仅面向一个 Hanyang HY-ON 学习身份的课堂字幕与文稿 PWA。课程由 Study Core 使用服务器端已绑定的 Canvas PAT 获取；本服务从不接触 PAT，也不保存原始课堂音频。

## 能力

- Hanyang Canvas 动态课程选择；Canvas 返回 0 门课程是正常状态。
- 韩语实时转录与简体中文字幕。
- 服务端创建课堂 ID，录制中每 4 秒增量、幂等保存文稿。
- 自动保存请求有 8 秒上限，同时最多保留一个执行中和一个合并待办；网络切换导致响应丢失时，会用同一 writer lease 读取最新 revision、自证后幂等重送，不会直接误判成其他设备接管。
- 刷新、断线或 Realtime 错误后可恢复未完成记录；尾段无法确认时保持 `failed`，只有用户再次明确确认，才能以“字幕可能不完整”结束。
- 连接中的结束或页面卸载会取消麦克风授权、临时凭据和 SDP；数据通道必须在限定时间内真正打开，迟到的音轨或连接会立即关闭。
- 每条未完成记录使用内存中的 writer lease 和递增 `revision`。另一设备仅打开页面不会改动正在录制的记录；继续或结束前必须明确确认接管，接管后旧页面的保存请求会收到 `409` 并停止录音。
- `recording`、`ready`、`failed`、`archived` 生命周期。
- 旧 Jiahuan 数据原样保留，旧课程标记 `legacy_unmatched`，不会猜测 Canvas ID。
- MCP 内部只读接口支持列表、详情与有界全文搜索。

“录制”在当前版本指实时采集麦克风用于转录。音频会实时传给 OpenAI，但不会被本服务持久化，也没有音频回放功能。

## 数据流

```text
浏览器 -> Study Lecture API -> Study Core -> Hanyang Canvas
                         \-> SQLite 文稿

Study MCP -> Study Lecture internal API -> SQLite 文稿
```

浏览器和 MCP 都不会获得 Canvas PAT、OpenAI 主密钥或内部 service token。浏览器开始转录时只会获得 OpenAI 签发的短期 ephemeral secret。

## 本地运行

复制 `.env.example` 的变量到本机环境，并为本地 Study Core 设置：

```powershell
npm.cmd install
npm.cmd run dev
```

非 production 模式的 Vite 和浏览器 API 都只绑定 `127.0.0.1`，API 还会要求 Host 精确为 `127.0.0.1:<实际端口>` 或 `localhost:<实际端口>`，避免局域网代理和 DNS rebinding 冒充本机 owner。不要把本地开发服务改成无认证的 `0.0.0.0`。

production 使用用户明确批准的公开模式，必须精确配置 `LECTURE_AUTH_MODE=public`；缺失、拼错或未知值都会拒绝启动。公开模式没有网页登录，任何拿到 `lecture.gaid.studio` 地址的人都能按同一个 Hanyang owner 查看和操作录播数据，并共享服务端限速额度。服务仍强制精确 Host、所有写请求的同源 Origin、2 MB JSON 上限、OpenAI 端点限速和独立 internal service token。公开模式不会把 Canvas PAT、OpenAI 主密钥或 service token 下发到浏览器。

## 命令

```powershell
npm.cmd run dev
npm.cmd test
npm.cmd run build
npm.cmd run server:start
```

## API 边界

浏览器同域 API：

```text
GET  /api/courses
POST /api/sessions
POST /api/sessions/:id/checkpoint
POST /api/sessions/:id/fail
POST /api/sessions/:id/resume
POST /api/sessions/:id/complete
GET  /api/sessions
GET  /api/sessions/:id
DELETE /api/sessions/:id        # 逻辑归档
```

创建与恢复接口会把一次性的 `writerLease.token` 返回给当前页面；checkpoint、fail、complete 必须同时提交该 token 和最新 `expectedRevision`。token 只保存在页面内存中，服务端只保存其 SHA-256 摘要。刷新后不会自动写回或自动判失败，必须基于页面看到的 revision 再次确认接管。只有 `ready` 记录可以归档。

Study MCP 使用独立 `LECTURE_SERVICE_TOKEN`：

```text
GET /internal/mcp/lecture/sessions
GET /internal/mcp/lecture/sessions/:id
GET /internal/mcp/lecture/search?q=...
```

## 数据兼容

- production 默认数据库仍为 `/data/jiahuan.sqlite`。
- `JIAHUAN_DB_PATH` 和 `JIAHUAN_STATIC_DIR` 暂时作为旧变量回退。
- 启动时原地增加新列、课程缓存和 FTS 索引；不删除旧记录。
- 历史数据库即使已有多条未完成记录，启动迁移也不会静默归档或改写它们；必须逐条显式接管并结束后才能创建新记录。
- `finalizationWarning` 会随浏览器记录、Markdown 和 MCP 结果保留，带警告的记录不得被解释为完整逐字稿。
- CI 在迁移前自动生成经过 `integrity_check` 的 SQLite 在线备份和旧 app 快照；手工部署也必须执行同等备份。

部署细节见 `DEPLOY_CICD.md`。
