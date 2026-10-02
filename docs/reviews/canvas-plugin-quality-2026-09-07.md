**Hanyang Study / Canvas 插件严格审查 — 2026-09-07**

**结论：工程底座合格，插件整体尚不精致。关键读取行为存在可复现的错误，因此还不能把它评为可以放心依赖的成熟插件。**

这里的“漂亮”指职责清楚、接口自解释、行为准确、成本可控、错误可诊断、能力增长后仍易维护。本次关注插件本身、MCP 契约、Skill 和实际读取链路，未修改业务代码，也没有接管其他任务的审查结论。

| 维度 | 严格判断 | 依据 |
| --- | --- | --- |
| 插件包装与产品边界 | 较好 | 10 个文件，App 映射简洁，单一 Hanyang 机构，三个入口的概念分工成立 |
| MCP 基础契约 | 合格 | 严格输入、结构化结果、错误封装、OAuth scopes、读写 annotations 都有实现 |
| 数据语义与完整性 | 未达到可靠标准 | Planner 状态读错；讨论回复、模块内容丢失；列表无法说明是否完整 |
| Skill 行为一致性 | 勉强合格 | 发信规则冲突，规划路由交叠，工具目录与领域规则重复维护 |
| 效率与检索体验 | 合格偏下 | 能做有界读取，但缺少续读；LearningX 发现链反复交换会话 |
| 扩展与交付 | 合格偏下 | 固定课表、双工具 registry、重复 envelope，缺少仓库内插件校验及行为评测 |

**审查范围与已取得的证据**

- 当前工作区包括大量未提交改动，含新增 Inbox send/reply；结论针对所读到的当前源码，不只针对某个 diff。
- 源码最多注册 35 个工具：24 个 Canvas 读取、6 个可选 LearningX、3 个可选 Lecture、2 个可选消息写入。
- 当前任务实际暴露 33 个 `hanyang_study_*` 工具，没有 send/reply。已安装包宣称 Read + Write。这个差异说明“源码、安装包、当前工具快照”尚未在本任务中验证一致；不能由此推断生产服务没有部署写能力。
- 插件源目录与已安装 `0.1.0+codex.20260907083501` 缓存的 10 个文件 SHA256 全部一致。
- Core 的 `npm.cmd test`：14 个测试文件、114 项测试全部通过；`npm.cmd run typecheck` 通过。
- 另外通过无网络、注入 synthetic fetch 的本地调用复现了下述 Planner、分页、模块、讨论、LearningX 结构问题及请求次数；通过 MCP SDK InMemoryTransport 验证了不同用户收到相同固定课表。
- 没有实际调用生产 Canvas、LearningX、Record 数据接口，没有发送消息，没有部署；本次结果不能替代线上端到端验证。
- JSON 文件解析与 marketplace reader 成功。插件和三个 Skill 的官方 validator 已尝试，但本机 Python 缺少 `yaml`，均未能启动；不能记作验证通过，也不能据此判定插件无效。未安装依赖。

**1. [P1] Planner 状态使用了错误的数据模型**

[client.ts:1286](D:/Projects/Study/apps/core/src/canvas/client.ts:1286) 把 Planner 的 `submissions` 状态对象交给普通 Submission 的 [submissionStatus:414](D:/Projects/Study/apps/core/src/canvas/client.ts:414)。后者主要识别 `workflow_state`、`submitted_at`，没有正确处理 Planner 的 `graded`、`needs_grading` 等布尔标志。两种上游对象语义不同。[Instructure Planner API](https://canvas.instructure.com/doc/api/planner.html) 展示了这种 flags 结构。

本地输入 `submissions: { graded: true, missing: false, excused: false }`，输出却是 `submissionStatus: "unsubmitted"`、`completed: false`。该项目留在默认未完成列表，还影响 `weekly_summary.counts.incompleteWork`。这是直接改变学生工作判断的错误。

应建立专门的 Planner 状态规范化，并用真实上游结构覆盖已提交待评分、已评分、缺交、免交及手动完成。现有 [weekly summary 测试](D:/Projects/Study/apps/core/test/canvas.client.test.ts:540) 的 Planner 样本没有 submissions，测试通过没有覆盖该语义。

**2. [P2] “最小查询”可能返回假的空待办列表**

[client.ts:920](D:/Projects/Study/apps/core/src/canvas/client.ts:920) 先按 `limit` 拉取原始记录，再在 922 行过滤完成项。达到数量上限时，[分页器](D:/Projects/Study/apps/core/src/canvas/client.ts:1437) 已经丢弃下一页。

本地设置 `limit: 2`，第一页两个手动完成项目，下一页存在一个未完成项目：最终返回 `[]`，只发出一次请求。越强调“小 limit”，越容易碰到这个缺口。

应在上游可用时采用未完成过滤，或按过滤后的返回数量继续有界分页，并报告覆盖范围。验收应包含“第一页全部完成、第二页仍有待办”。

**3. [P2] 两个读取接口把真实内容静默丢掉**

讨论接口 [client.ts:1210](D:/Projects/Study/apps/core/src/canvas/client.ts:1210) 读取 `raw.replies`，实际调用的 entries 接口返回 `recent_replies` 和 `has_more_replies`。含教师回复的本地样本输出 `replies: []`，也没有后续读取回复的工具。现有 [测试样本](D:/Projects/Study/apps/core/test/canvas.client.test.ts:402) 使用了 `replies`，与实际端点契约不符。[Instructure Discussion Topics](https://developerdocs.instructure.com/services/canvas/resources/discussion_topics)

模块接口 [client.ts:686](D:/Projects/Study/apps/core/src/canvas/client.ts:686) 只请求内联 items，[规范化逻辑](D:/Projects/Study/apps/core/src/canvas/client.ts:1110) 把缺失 items 变成 `[]`，同时丢弃 `items_count` 和 `items_url`。官方允许模块内容较多时不提供内联 items，要求另取 module items。本地输入 `items_count: 20` 且省略 items，输出空数组，无补充请求。[Instructure Modules](https://developerdocs.instructure.com/services/canvas/resources/modules)

用户问“老师有没有回复”或“这一周有哪些材料”，返回结果无法区别“真的没有”和“接口没有取回”。应保留未加载状态及数量，提供按 ID 读取剩余回复、模块子项的路径。

**4. [P2] 列表和历史检索缺少完整性与续读契约**

[getAllRecords](D:/Projects/Study/apps/core/src/canvas/client.ts:1405) 最终只返回 `slice(0, limit)`。多数 MCP 列表返回裸数组，没有 `hasMore`、`nextCursor` 或 `truncated`。公开 Canvas limit 最大 200。超过上限的 Inbox 历史既无法枚举，也无法知道遗漏是否存在。

Lecture [工具输入](D:/Projects/Study/apps/core/src/mcp/lectureTools.ts:34) 只有 course/status/limit，列表最多 100；生产 D1 的 [listSessions](D:/Projects/Study/apps/record/worker/db.ts:369) 按时间倒序 LIMIT，没有日期或 cursor。搜索采用连续子串 LIKE，最多 50 条，缺少 session/date 限定和续页。大量新记录或重复词会挤掉旧记录。命中片段后也只能取整个 transcript，缺少片段周边上下文读取；完整读取又有 2 MiB 响应限制。

保留有界读取，同时让结果自述 `returnedCount`、`hasMore`、续读方式和覆盖范围。Lecture 增加日期/session 过滤及 segment 范围读取。当前小档案可以使用；不能把现有 LIKE 查询描述为语义检索或相关性排序。

**5. [P2，用户与学期扩展边界] 课表是固定常量，描述却声称属于当前用户**

[get_timetable handler](D:/Projects/Study/apps/core/src/mcp/canvasTools.ts:475) 调用不带身份参数的 [getHanyangTimetable](D:/Projects/Study/apps/core/src/timetable.ts:157)，返回固定的 2026 年第二学期常量。连接归属检查存在，但课表数据没有按用户或学期绑定。

本地用两个不同的 synthetic App 用户和 Canvas 用户调用：均成功、均返回相同的 7 条 meeting、上游请求均为 0。未观察到真实用户数据泄露；但如果第二名用户接入，接口会把同一份个人课表描述成对方的课表。换学期也需要修改源码。

私人导入课表本身合理。应把导入记录绑定 owner 和 term，非 owner 返回明确不可用，并报告来源时间与适用学期。无需增加机构切换器或泛化 provider 框架。

**6. [P2] Skill 对已授权发信给出了相反指令**

[Study Skill:8](D:/Projects/Study/plugins/canvas/skills/study/SKILL.md:8) 允许显式 send/reply 转交 Canvas workflow；[同文件:32](D:/Projects/Study/plugins/canvas/skills/study/SKILL.md:32) 又无条件禁止 post messages 和 modify Canvas。Canvas/Study 的 agents YAML 仍把整个依赖描述为 read-only。

用户说“先看作业要求，再替我给老师发一个询问”，两个规则同时适用，可能导致无谓拒绝或重复确认。这里是静态指令冲突，未做模型对照实验，不能声称每次一定拒绝。

现有 [Canvas 消息规则](D:/Projects/Study/plugins/canvas/skills/canvas/SKILL.md:62) 已正确区分 draft/send、明确授权、收件人解析、稳定 request ID 和未知投递结果。应修正上层笼统禁令并同步能力文案，保留这套边界。

**7. [P2] LearningX 会把错误形状变成成功空列表**

[learningx/client.ts:59](D:/Projects/Study/apps/core/src/learningx/client.ts:59) 的 `records()` 对非数组返回 `[]`；attendance/modules/boards 的列表直接使用它。与 Canvas 分页器的根结构校验不同，MCP 输出校验发生在数据被清空之后。

本地让 boards 返回 HTTP 200、JSON `{ "error": "application-level error" }`：`listBoards()` 成功返回 `[]`。这会把上游业务错误或协议变化呈现成没有公告板。

应先按上游接口验证根结构，再转换；错误对象返回 `invalid_response` 或已识别业务错误。真正的空数组才是成功空集。

**8. [P2/P3] 规划入口缺少面向真实任务的覆盖与降级设计**

[Study Skill:18](D:/Projects/Study/plugins/canvas/skills/study/SKILL.md:18) 推荐日/周规划使用 timetable + weekly_summary。但 [weeklySummary](D:/Projects/Study/apps/core/src/canvas/client.ts:958) 把未来工作窗口同时用于公告发布日期：昨天发出的“今天换教室”可能不在窗口中。Skill 虽然禁止凭没有公告推断线下/线上，仍没有给出检索这些生效通知的回溯规则。

同一聚合器通过 Promise.all 和后续 announcements 串联读取；任一集合失败，已经成功的集合也无法返回。它会明确报错，没有静默伪装成功，但作为 overview，对局部权限差异缺少降级能力。

“本周要交哪些作业”也会同时匹配 Canvas 和 Study 两个 Skill。前者强调窄查询，后者固定加课表与聚合器，数据范围不稳定。应让单源问题使用最小工具，跨来源问题才读取第二来源；规划窗口和通知回溯窗口分别表达，聚合结果返回每个来源的 coverage/errors。

**9. [P3] LearningX 的首次发现链有可量化的重复开销**

按 Skill 的 `listBoards → listBoardPosts → getBoardPost` 路径，本地 mock 计数为 15 次 HTTP、3 次 LTI form POST。每一步重新执行 tabs → sessionless launch → verifier → form → 数据。[launch 实现](D:/Projects/Study/apps/core/src/learningx/client.ts:509) 没有会话复用，[MCP wrapper](D:/Projects/Study/apps/core/src/mcp/canvasTools.ts:346) 每次创建新客户端。

这不是所有查询的固定成本：已有 external_tool_id 时三步为 12 次；所有 ID 已知而直接读详情为 4 次。以上是请求次数，未测生产延迟。

可以评估按 user/course/tool 隔离、短时有效、到期失效的会话复用，以及避免不必要的再次发现。不要以长期共享 JWT 缓存换取表面速度。

**10. [P3] 信息维护位置过多，已经出现契约分叉**

33 个读取工具的输入属性没有 `.describe()` 参数说明；仅两个消息工具各有两个参数说明。日期边界、limit 语义、external_tool_id 来源等仍需模型从实现外部推断。离线 `tools/list` 最大集合序列化为 136,908 个 JSON 字符；这是 wire schema 体积，不能当成实际模型 token 成本。

[Canvas Skill:24](D:/Projects/Study/plugins/canvas/skills/canvas/SKILL.md:24) 开始有 19 个工具选择条目，其中相当一部分重述工具 description。该 Skill 约 1,089 个英文词，长度本身不算失控，维护职责混合更值得修正。

[canvasTools.ts:285](D:/Projects/Study/apps/core/src/mcp/canvasTools.ts:285)、[331](D:/Projects/Study/apps/core/src/mcp/canvasTools.ts:331)、[374](D:/Projects/Study/apps/core/src/mcp/canvasTools.ts:374) 三种注册 wrapper 重复 SDK 注册与自建 Map；[116](D:/Projects/Study/apps/core/src/mcp/canvasTools.ts:116) 覆盖 tools/list。当前静态注册可以工作，双状态源会增加未来工具启停和扩展的同步负担。OpenAI 根级 securitySchemes 兼容有明确目的，应把适配集中到一处。

Canvas 和 Lecture 分别复制错误及 envelope；新增 [messages.ts:17](D:/Projects/Study/apps/core/src/canvas/messages.ts:17) 又提供更松的第三套输出约束，缺少既有 strict/oneOf 一致性。应共用 envelope/error 工厂和工具定义入口，保留各领域 handler。

保留 text + structuredContent 的兼容输出有规范依据。优化应关注列表与详情的字段预算、HTML/plain text 双份内容和可续读性，不能简单删除兼容输出。[MCP Tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

**11. [P3] 质量门禁覆盖应用，尚未覆盖插件行为**

[CI](D:/Projects/Study/.github/workflows/ci.yml:24) 只运行 Core/Record 安装、类型检查、测试、构建；[插件 README:28](D:/Projects/Study/plugins/canvas/README.md:28) 把插件/Skill 校验留给手动流程。当前测试证明了很多安全边界和内部结构，但上述真实协议形状错误依然通过。

本次检索未找到插件的标注用户问题集或工具选择行为评测。应建立少量真实任务：仅查截止日期、今日上课地点、昨天发布的临时通知、部分集合 403、旧录音按日期找回、文件目录无权但附件可读、只写草稿、已授权发送、投递未知、跨学校问题。每个任务标注必要工具、可接受读取范围、证据和不能作出的推断。

OpenAI 的元数据指南明确建议覆盖直接、间接和负向提示词，并记录工具选择及参数；schema validator 无法替代这一层。[Optimize Metadata](https://developers.openai.com/plugins/guides/optimize-metadata)

**应保留、收紧和新增的内容**

| 动作 | 具体范围 |
| --- | --- |
| 保留 | 单 Hanyang、PAT 只在 Core、Lecture owner 检查、固定源与重定向校验、输入/输出 schema、Inbox 不标已读、消息幂等账本、转写来源和 finalizationWarning |
| 收紧 | Canvas Skill 保留学校事实语义与授权；Study 负责是否引入第二来源及冲突；Lecture 负责引用和转写不确定性 |
| 移到契约 | 工具用途、参数语义、默认排序、时间边界、分页/截断、错误和重试含义 |
| 删除重复 | 已不成立的全局禁发信文案、重复工具目录、重复 envelope/error 定义；保留必要兼容字段 |
| 补齐 | Planner 专用解析、回复/模块子项读取、完整性元数据、历史续读、owner/term 课表绑定、上游结构验证 |
| 增加验证 | 真实上游 fixture、插件校验命令及 CI、代表性用户问题回放；之后分别验证当前连接和线上接口 |

**修复顺序：先修会答错或假空的读取语义，再补完整性和历史续读，再统一 Skill 与能力文案，最后收敛注册机制、优化调用开销。**

三个 Skill 可以保留，有清晰职责的 MCP 工具也可以保留。达到精致标准需要让每个成功结果都能说明“读到了什么、还缺什么、下一步能怎么取”，并让同一个用户请求在不同入口下得到一致的权限与检索行为。
