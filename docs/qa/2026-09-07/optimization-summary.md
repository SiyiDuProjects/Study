> 历史检查记录：文中的“未部署”指当时状态。2026-09-07 全量发布已完成，当前状态见 [统一发布记录](../../releases/2026-09-07-current.md)。

**Hanyang Study / Canvas 优化交付记录 — 2026-09-07**

本轮已根据两份审查修改 Core、Record、MCP 与三个 Skill，保留单一 Hanyang、Core 独占 PAT、独立服务凭据、只读事实接口及单收件人消息授权边界。修改前保存了包含当时未提交内容的工作区快照；没有回退同时进行的字幕界面工作。

**实现结果**

- Planner 使用自己的布尔状态模型，未知完成度保留 null；完成过滤先于数量限制。LearningX 的 completed、useAttendance、required 同样区分真假与未知。
- Canvas 集合统一为 items / nextCursor；游标按用户、凭据、操作和过滤条件绑定。模块父项与子项分页分开，讨论保留 recent_replies 并能继续读完整回复。
- weekly_summary 保留为薄兼容入口：每个来源独立成功或失败，移除第二套完成计数；公告回溯窗口与计划窗口分开。Skill 根据问题选择来源，旧 Inbox 消息的未来安排不会被“本周发布”窗口自动排除。
- Core、Record、浏览器共用录音读取契约。daily 可查询，历史模型元数据可读；列表、搜索和转录支持日期、session、片段范围与续页。坏记录返回定位警告，长转录通过有界页读取。
- 移除 Record 重复的 Express 路由、SQLite 运行仓储及独立 dev server。开发、测试和生产构建指向 Worker/D1；保留纯 OpenAI/课程服务模块。增量 checkpoint 使用带修订约束的 UPSERT，保留旧字幕、writer lease、revision 和 finalizationWarning。
- 合并 MCP 注册、严格 envelope/error、兼容文本输出和 OAuth 元数据；HTML 统一使用 parse5 允许列表转换，保留可用文件路径并删除能力查询凭据。公开错误和异常日志不再透传原始上游正文、异常文本或请求片段；已知写入冲突使用明确错误类型。
- 课表与教学日历移入一份导入数据，绑定经验证的 Canvas owner 和适用学期；其他用户或学期明确不可用。内部课程目录完整续页成功后才写入数据库。
- 三个 Skill 保留各自职责，删去重复 API 目录、固定规划调用链及发信规则冲突。增加仓库校验命令、CI 门禁和 13 个由独立子代理生成的离线工具选择推演。

**简化的数量证据**

与修改前的工作区快照比较，Core 与 Record 后端 TypeScript 从 **13,547 行降至 12,041 行，净减 1,506 行**；另将原有课表常量迁为 JSON 数据。该统计排除测试和另一个任务的 Record 前端界面改动，不使用旧 git HEAD 混算。三个 Skill 从 **1,874 词降至 1,108 词，减少约 41%**。

LearningX board list → posts → detail 在合成请求计数中从 **15 次 HTTP / 3 次 LTI POST 降为 7 / 1**，短期缓存仍按账号、凭据、课程与工具隔离；这不是生产延迟测量。

数量原始记录：[optimization-size.json](./optimization-size.json)。

**验证与交付层次**

Core **16 个测试文件、192 项测试**通过；Record **17 个测试文件、64 项测试**通过，合计 **256 项**。两侧类型检查、构建均通过，Record 构建包括 Sites Worker 和浏览器产物。Core 最终 [Vitest JSON 结果](./optimization-core-tests.json) 已保留；原有 G01–G08 安全探针已全部由正式测试承接，见独立审计映射。

构建后的 Record 模块已在真正的 workerd / Miniflare 与临时 D1 中运行：健康检查、拒绝无服务凭据请求、历史模型读取以及超过 2 MiB 转录的四页遍历均通过。该检查不读取真实环境文件、不调用 OpenAI/Study、不访问用户录音数据库。

官方 Codex 插件 validator、三个官方 Skill validator、仓库 `npm run validate:plugin` 以及 `git diff --check` 均通过。CI 现包含本地插件校验和构建后 Worker smoke。

本机插件已从既有本地 marketplace 重装为 **0.1.0+codex.20260907092932**，保持 enabled；源目录与安装缓存的 **10 个文件 SHA256 全部一致**。本地 SDK 全功能配置的 [tools/list 清单](./optimization-tool-inventory.json) 实际返回 **37 个工具：35 个读取、2 个单独 write scope 的消息工具**，根级与 _meta OAuth 声明一致。此次发现请求没有调用工具或访问网络。当前任务仍是旧的 33 个远端读取工具快照；三种证据不互相替代。

13 个行为场景结果为 9 项规则支持、4 项带明确范围/读取成本限制。推演记录具体工具选择、参数模板、续读条件、答案边界和禁止推断；未实际执行 MCP 调用，因此不计算模型端到端通过率。

**明确保留的证据边界**

本轮没有部署 Core 或 Record，也没有进行真实发信、手机录音、账号切换或 Passkey 操作。新的分页响应需要两个服务配套发布；发布与回滚说明已加入 [DEPLOY_CICD.md](../../../DEPLOY_CICD.md)。重新安装插件不会自动发布后端，也不会刷新既有任务的远端工具快照。

原先的生产只读检查发现 attendance 空集、周学习树却有两项已完成考勤视频；当时对“来源覆盖不同”的解释没有页面证据。后续用户截图及实际登录页面证实 Lecture/Attendance 同样显示两项已出席。核对页面加载的官方脚本后，已定位客户端使用了旧 allcomponents_db 路径，学生考勤页实际使用 attendance_items 和 attendance_items/summary。后续修复及验证边界见 [考勤读取修复](./attendance-read-fix.md)；早先的空集不应再以来源范围不同来解释。

Record 前端构建仍提示单 bundle 大于 500KB。该提示不影响构建通过，本轮没有把同时进行的字幕界面改动扩展为前端拆包重构。

**证据文件**

- [逐项独立复核](./optimization-audit.md)：两份审查的 11 + 10 项及两项架构建议。
- [离线工具选择推演](./skill-forward-traces.json)：13 个带上下文的代表性请求。
- [本地 SDK 工具清单](./optimization-tool-inventory.json)：实际工具发现请求、工具权限分组和源码 hash。
- [Core 最终机器测试结果](./optimization-core-tests.json)：192 项通过。
- [当前生产只读观察摘要](./optimization-live-read-evidence.json)：不含凭据或转录正文。
- 原 [report.md](./report.md)、[probe-results.json](./probe-results.json) 与 [repro.mts](./repro.mts) 保留为修复前历史证据。旧脚本按旧返回结构断言；当前持续回归由正式测试套件承接，没有维护第二套兼容运行时。
