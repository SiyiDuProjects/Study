# Study

Study 用一套代码支持 Berkeley bCourses 和 Hanyang HY-ON。一个 ChatGPT 账号中的一个私有 Study 插件分别连接两个学校账号，共用 Canvas 读取实现；Hanyang 另有 LearningX、课表、课堂记录和单独授权的 Inbox 发信能力。网站与认证固定在 https://study.siyidu.com，插件入口固定在 https://study.siyidu.com/mcp。本地 Codex 包装仅用于用户明确要求的开发验证。

课堂录播是 Study 下的功能模块，负责实时字幕、转写和翻译文稿。目前该功能属于 Hanyang 连接。`Record` / `Lecture` 是这个子模块的内部名称，不是另一套插件或独立产品。

## 目录

- `apps/core`：运行在 VPS 的 Canvas OAuth、课程同步和远程 MCP 服务。Canvas PAT 只在这里加密保存。
- `apps/record`：运行在 OpenAI Sites 的课堂实时字幕与录播文稿网站，结构化数据保存在 Sites D1。
- `plugins/study`：Study 插件源码与 Canvas、汉阳每日提醒、Study、Study Lecture 四个 skills。
- `.agents/plugins/marketplace.json`：保持有效的空目录，避免桌面端自动展示本地 Study 副本；只有用户明确要求本地安装时才添加登记。

## 数据流

```text
Berkeley / Hanyang Canvas <- independent PATs -> Study Core / MCP <- per-account OAuth -> one Study plugin
                           ^                    |
                           | course catalog     | lecture.read tools
                           v                    v
                    Study Record (Sites + D1)
```

Study Record 只通过独立的 service token 读取 Core 课程目录；Core 只通过另一个独立 token 读取 Record 的录播文稿。两个方向不复用 PAT、OAuth token 或 OpenAI key。

## 常用命令

以下命令在 macOS/Linux 使用 `npm`；Windows PowerShell 可将 `npm` 替换为 `npm.cmd`。

发布从 [统一发布流程](docs/release-workflow.md) 开始；[最近上线记录](docs/releases/latest.json) 记录 Core 镜像、Sites 版本与线上验证。修改 Skills 只编辑 `plugins/study/skills`，修改工具编辑 `apps/core/src`，修改录音网站编辑 `apps/record`。

```sh
npm run typecheck
npm test
npm run build
npm run validate:plugin
npm run release:status
npm run release:check
npm run release:prepare
```

也可以分别在 `apps/core` 或 `apps/record` 中运行各自的命令。Record 的 `dev` 和 `build` 直接运行同一套 Worker/D1 实现；本地 D1 迁移由 `sites:db:apply` 应用。单独构建 Sites 产物使用：

```sh
npm --prefix apps/record run sites:build
```

## 发布边界

- 插件以线上 ChatGPT Study 的双学校连接为交付目标。本地修改、校验、marketplace/cachebuster 更新或 Codex 安装均不能作为线上已交付的证据。
- `.app.json` 只关联已注册的远程 App，不会上传本地 Skill 文件。发布前先核实当前支持的线上导入或更新方式，再验证导入结果及目标 ChatGPT 账号中 Skill 的实际可用性。
- Canvas 标准能力由两校共用：读取、上传文件、个人作业提交和单收件人私信（可带附件）。一次账号授权覆盖已启用功能；发送和提交须来自用户明确请求，不再另分读写授权。转发、考试、分组或外部工具提交及其他写操作不在本次范围。
- Record 用户数据由 Sites 身份和 `STUDY_OWNER_EMAIL` 校验保护；Sites 访问模式以实时设置为准，发布时保留已有模式。
- 不持久化原始课堂音频；当前只保存转写和翻译文稿。
- 生产密钥只存在于 VPS 环境文件或 Sites secret 环境变量中，绝不进入 Git。

部署、备份和回滚说明见 `DEPLOY_CICD.md`。
