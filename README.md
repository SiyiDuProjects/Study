# Study

Study 是一个只服务于 Hanyang HY-ON 学习账号的私有学习系统。它把 Canvas 课程事实、课堂录播转写和 ChatGPT/Codex 插件放在同一个仓库里，但仍保持清晰的服务边界。

## 目录

- `apps/core`：运行在 VPS 的 Canvas OAuth、课程同步和远程 MCP 服务。Canvas PAT 只在这里加密保存。
- `apps/record`：运行在 OpenAI Sites 的课堂实时字幕与录播文稿网站，结构化数据保存在 Sites D1。
- `plugins/canvas`：Codex/ChatGPT 使用的 Canvas 插件和三个学习 skills。
- `.agents/plugins/marketplace.json`：仓库本地插件市场入口。

## 数据流

```text
Hanyang Canvas <- PAT -> Study Core / MCP <- OAuth -> ChatGPT / Codex
                           ^                    |
                           | course catalog     | lecture.read tools
                           v                    v
                    Study Record (Sites + D1)
```

Study Record 只通过独立的 service token 读取 Core 课程目录；Core 只通过另一个独立 token 读取 Record 的录播文稿。两个方向不复用 PAT、OAuth token 或 OpenAI key。

## 常用命令

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

也可以分别在 `apps/core` 或 `apps/record` 中运行各自的命令。Record 的 Sites 构建使用：

```powershell
npm.cmd --prefix apps/record run sites:build
```

## 发布边界

- Canvas/MCP 第一版保持只读；提交作业、发消息、上传文件等写操作必须另做评审版本。
- Record 网站使用 Sites 私有访问，不再公开匿名开放。
- 不持久化原始课堂音频；当前只保存转写和翻译文稿。
- 生产密钥只存在于 VPS 环境文件或 Sites secret 环境变量中，绝不进入 Git。

部署、备份和回滚说明见 `DEPLOY_CICD.md`。
