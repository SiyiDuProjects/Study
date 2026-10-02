# 两份审查报告的实现完整性复核

复核日期：2026-09-07。依据当前工作区源码、测试、三份 Skill、独立离线行为推演，以及无网络的合成请求。历史报告和旧探针保留原样；它们描述修复前的状态，不能当作当前测试结果。

本文件将“本地实现已覆盖”“行为规则已说明”“线上根因仍未确认”分开。独立复核没有部署、安装插件、发送真实消息、解密生产凭据或启动录音；主任务另行完成了插件重装及源文件与安装包的哈希核对。应用完整检查结果由本次优化交付记录列出；此处不重复估算完整测试通过数。

最终复核时，两份报告中可由本地实现和回归测试验证的优化项均已覆盖，额外发现的日志、续读停止条件和 LearningX 未知状态问题也已收紧。没有留下新发现且可复现的本地阻断问题；线上考勤枚举差异仍保留原证据边界。

## 原质量审查的 11 项

| 原项 | 当前实现与独立核对 | 结论 |
| --- | --- | --- |
| 1. Planner 误读 Submission 数据模型 | `normalizeUpcomingWork` 单独处理 Planner flags；未知状态保留空值；正式提交详情仍优先。Canvas 客户端及 MCP InMemoryTransport 用真实 flags 形状验证 submitted、needs_grading、graded、missing、excused、手动完成及未知。 | 本地实现已覆盖 |
| 2. 先 limit 再过滤产生假空 | 使用上游 incomplete_items，并在完成过滤后计数；保留剩余行与分页游标。测试包含首批全完成而后页有待办。 | 本地实现已覆盖 |
| 3. 模块子项和讨论回复丢失 | 模块返回元数据及 itemCount，子项由 `list_module_items` 单独分页；讨论保留 recent_replies / hasMoreReplies，并由 `list_discussion_replies` 获取完整回复集合。跨层测试用返回 ID 完成父项到子项的读取。 | 本地实现已覆盖 |
| 4. 列表与 Lecture 无续读 | Canvas 集合返回 items / nextCursor；游标绑定用户凭据、操作及过滤条件，不接受任意 URL。Lecture 支持列表日期、搜索 session/date、字幕时间范围、坏行警告与稳定排序游标；Worker 测试覆盖超过 100 条录音及超过 2 MiB 字幕。LearningX boards 原有分页保留上游 page/total 信息。 | 本地实现已覆盖；LearningX 两种枚举来源仍不可宣称覆盖一致 |
| 5. 固定课表被描述为当前用户课表 | 课表迁入一份带 ownerCanvasUserId、学期与教学日历的数据；公开与内部读取均验证 Canvas 身份，按首尔日历判断学期有效范围。测试覆盖其他用户、过期学期及时区边界。 | 本地实现已覆盖；仍是一份个人导入课表，不是学校实时排课接口 |
| 6. Skill 发信授权冲突 | 三份 Skill 去除重复工具目录与全局禁发信冲突；草稿、明确发送、单收件人、write scope、unknown 去重边界有一致说明。实际能力以运行工具表为准。 | 规则已覆盖；没有真实投递验收 |
| 7. LearningX 错误对象变空列表 | 数组及元素、必需 ID、嵌套 module_items 均校验；对象错误、损坏条目、缺失子列表返回 invalid_response。完成、考勤启用及必修状态缺失或非布尔时返回 null。 | 本地实现已覆盖根结构、身份与未知状态边界 |
| 8. 周报来源与降级承诺 | weekly_summary 保留为兼容事实组合，移除完成计数；来源分别返回成功页或安全错误。计划窗口与公告回溯窗口独立表达；指定课程先于 limit 过滤。Skill 按问题决定是否读 Inbox、LearningX 和 Lecture，并明确覆盖范围。 | 本地实现与规则已覆盖；保留兼容工具是有意选择 |
| 9. LearningX 发现链重复开销 | 共享短期内存 launch 缓存，按 App 用户、Canvas 用户、PAT、课程和 tool 隔离；有限容量、短 TTL、JWT 过期及认证失败失效。测试验证独立客户端复用与隔离。 | 本地实现已覆盖；没有生产延迟测量 |
| 10. 元数据、envelope、注册重复 | 统一 scoped tool 注册与安全结果封装，保留 OpenAI 根级 OAuth mirror 的 SDK 兼容适配；参数语义移入 schema。Canvas、LearningX、Lecture、消息共用严格 envelope/error；MCP 测试验证 oneOf、scope mirror 和无效输出转安全失败。 | 本地实现已覆盖；兼容 mirror 仍有必要 |
| 11. 缺少插件与行为门禁 | 仓库内 `validate:plugin` 校验 manifest、marketplace、路径及三份 YAML/Skill；CI 调用校验与应用检查。`skill-forward-traces.json` 提供 13 个独立子代理离线推演场景。 | 本地门禁与行为语料已补；离线推演不能称端到端模型通过率 |

## 独立 QA 的 10 项及两项架构建议

| 原项 | 当前实现与独立核对 | 结论 |
| --- | --- | --- |
| 1 / P01、P02：提交事实冲突 | 对应上表 1、2；MCP 用实际 Planner flags fixture 验证，缺失状态不默认未交。 | 本地实现已覆盖；需部署后再交叉核对报告中的真实作业 |
| 2 / P11：旧模型使整批录音失败 | 历史 models 是有长度限制的字符串；创建模型策略独立。Core 与 Record 共享公开读取 schema；坏行被定位并返回其余健康记录。 | 本地实现已覆盖 |
| 3 / P07、P08：考勤列表空但周学习存在视频 | 非数组不再转空；多候选 tab 明确 ID。后续截图及实际页面脚本证实旧 allcomponents_db 不属于当前学生考勤页的读取链，已改为 attendance_items + summary 并按页面考勤开关筛选。 | 后续本地修复，详见 [考勤读取修复](./attendance-read-fix.md)；生产尚未发布，不能标作线上验证通过 |
| 4 / P03、P06、P10：分页与过滤 | 对应上表 2、4、8；游标测试覆盖溢出行、分页预算、默认时间窗口固定、篡改及跨账号/操作/过滤重放拒绝。 | 本地实现已覆盖 |
| 5 / P04：模块误空 | 父模块不再伪装已加载子项；module item 独立列表可续页。 | 本地实现已覆盖 |
| 6 / P05：周报任一来源失败抹去其他事实 | sources 分别封装结果；局部 403 保留其他成功来源，移除另算完成度的业务判断。Skill 说明旧通知的未来生效日期及来源覆盖。 | 本地实现与规则已覆盖 |
| 7 / P09：daily 输入输出不一致 | Lecture 查询复用共享 courseId 契约，daily 和服务返回的历史课程引用可读；创建仍从 Core 课程列表或唯一 daily 选择。 | 本地实现已覆盖 |
| 8 / P15：标点改变 401 诊断 | 不再按人类报错文本识别登录状态；资源 401 为 access_denied，连接 profile 失败单独处理，且不会伪装成 MCP OAuth 重授权挑战。 | 本地实现已覆盖 |
| 9 / P12、P13、P14：HTML、能力链接、公开错误边界 | Canvas 与 LearningX 共用 parse5 允许列表转换；编码活动 URL、verifier/query、源脚本不输出，保留可使用的文件 ID 与安全文本。公开上游错误使用固定文案。额外日志边界复核见下文。 | 公开结果与日志边界本地实现已覆盖 |
| 10：能力与 Skill 漂移 | manifest 按运行可用性描述写能力；Skill 明确工具缺失不能自动归咎凭据。源码注册、安装包、当前远端快照仍是三种证据。 | 本地说明已覆盖；不将源码修复当作远端工具已更新 |
| 架构建议 1：课表重复定义 | 教学日历与课表同源；内部 Record 消费 Core 导入课表。未新增多机构或 profile switcher。 | 本地实现已覆盖 |
| 架构建议 2：Record 双后端漂移 | 删除 Express/SQLite 运行路径，本地 dev/build/preview 指向 Worker/D1；OpenAI 与课程访问保留为 services 纯模块，旧路由和生命周期覆盖迁入 Worker 测试。SQLite 仅作为 D1 测试适配器，不是第二个生产仓储。 | 本地实现已覆盖；实际 Worker build/smoke 结果由交付验证记录列出 |

## 复核中额外发现的边界

1. **错误日志中的原始请求片段。** 独立 synthetic HTTP 请求证明：全局 express.json 解析非法 JSON 后，Error.message 包含原始字符串；`app.ts` 的错误中间件交给旧 logger 后，HTTP 400 公开响应安全，但日志仍包含 synthetic 标记。Core 与 Record 现共用 safeErrorDiagnostic，仅记录受控类型和 HTTP 状态，不记录任意异常文本、stack 或路径。独立重跑原请求确认 HTTP 400 行为保留，公开响应和错误日志均不再含标记。Worker 另将“no longer writable”文案匹配改为 SessionNotWritableError 类型判断；带该短语的未知 D1 异常仍返回固定 502，合法关闭后的写入固定返回 409。两种情况的 Worker 回归均通过。
2. **字幕续读的停止条件。** Worker 合法返回 nextCursor=null、rangeComplete=false，表示已到最后页但先前有坏行。Skill 已要求遇到空游标停止并报告缺口；不能循环直到 rangeComplete=true，也不能将其解释为没有保存内容。
3. **毫秒字段的读写差异。** 初次 schema 对比发现 writer 接受小数、reader 要求整数；进一步核对并执行保存读取确认 D1 写路径已有 Math.round，输入 123.456 ms 能保存并正常读取。因此没有证据证明当前合法写入被 reader 丢弃；历史小数字段的宽容读取属于兼容性增强，不能描述为已复现的线上或当前写入故障。
4. **LearningX 未知完成状态。** 额外检查发现缺失 completed 会被旧 booleanValue 变成 false；现 completed、useAttendance、required 均只接受实际布尔值，缺失、null、字符串、数字及对象返回 null。列表、周学习和单项的共享规范化及 MCP schema 已同步；回归覆盖三种来源一致性和显式 false 不被 wrapper 覆盖。根结构有效不再被用作“未完成”的证据。

## 历史 G01–G08 安全断言的当前归属

这些断言保留在现有领域测试中，不复制旧 23 项探针建立另一套框架。此次补齐 G01、G03、G05；逐项核对时又补齐 G06 的显式 null 断言和 G08 的真实并发调用测试，避免把串行重试推断为并发安全。

| 历史编号 | 当前持久测试 | 直接验证的边界 |
| --- | --- | --- |
| G01 | `canvas.client.test.ts` — rejects a path-like Canvas ID before making any request | `../users/self` ID 返回 invalid_argument，fetch 为 0 次 |
| G02 | `canvas.client.test.ts` — rejects an unsafe next link before sending the token | 跨域、降级 HTTP、非 API 路径的 next link 返回 unsafe_pagination，不发第二次请求 |
| G03 | `canvas.client.test.ts` — rejects a self-referencing next link even when the requested page is already full | 单行已填满 limit=1，仍先拒绝指向当前 URL 的 Link，fetch 仅 1 次 |
| G04 | `canvas.client.test.ts` — reads Inbox without marking messages read and sanitizes conversation bodies | Inbox GET 明确携带 auto_mark_as_read=false |
| G05 | `canvas.client.test.ts` — rejects a reversed Planner date window before making any request | 终点早于起点返回 invalid_argument，fetch 为 0 次 |
| G06 | `canvas.client.test.ts` — lists only the authenticated student's course submissions with sanitized feedback | 共享 Submission 规范化显式保留缺失 score=null、grade=null，不生成 0 |
| G07 | `fileLinks.test.ts` — rejects tampered and expired tokens | 文件能力链接在精确到期边界失效 |
| G08 | `canvas.messages.test.ts` — claims concurrent identical requests before issuing one POST | Promise.allSettled 同时发起相同 request_id 的两次 deliver，仅一次 synthetic POST；随后重试仍不增发 |

补齐后的上述三个测试文件合计 **59 项通过**。与前面的聚焦复核有重叠，不将两次运行相加为独立用例数。

## 本地 SDK 工具清单

`optimization-tool-inventory.json` 来自实际 MCP SDK 1.30.0 的 InMemoryTransport 握手及一次 tools/list。可选 LearningX、Lecture、消息服务均配置，OAuth scope 不作额外覆盖，使用 `app.ts` 同样的默认注册配置。记录的客户端方法仅有 initialize、notifications/initialized、tools/list；tools/call、网络请求、账号连接读取和真实发信均为 0 次。

- 共 **37 个工具：35 个只读、2 个写入**。只读部分为 Canvas 26、LearningX 6、Lecture 3；写工具为 send_message、reply_message。
- 32 个 Canvas / LearningX 工具要求 canvas.read；3 个 Lecture 工具要求 canvas.read + lecture.read；两个写工具要求 canvas.read + canvas.messages.write。根级与 `_meta` 的权限镜像逐项一致。
- JSON 同时记录工具 annotations、输入输出 schema 哈希及注册源码哈希，便于后续比较；这是本地完整配置清单，不能当作当前会话的远端工具快照、实际账号 scope 授予或生产部署证明。

## 验证范围

- 代码与 fixture 能证明协议形状、分页、来源隔离、输出契约和受控错误边界；不能证明所有真实课程当前上游均使用这些形状。
- `skill-forward-traces.json` 明确是独立子代理离线推演，externalToolCallsExecuted=0。它记录工具选择与参数模板、证据和禁止推断；末轮为 9 个规则支持场景、4 个带已知限制的场景，不计算实际模型成功率。
- 独立末轮针对变更边界运行 Core 的 LearningX / logger / MCP Canvas 三个测试文件：50 项通过；Record 的 Worker index / lecture read / lifecycle 三个文件：18 项通过。这 68 项是聚焦复核，不替代主任务的完整 typecheck、test、build 与实际 Worker smoke 检查。
- 原 `repro.mts` 和 `probe-results.json` 为修复前历史证据。当前 API 已改变，不能直接用旧脚本的 import 或旧返回结构断言判定修复后的成败；对应缺陷由现有跨层回归测试承接。
- 线上 LearningX 枚举差异、部署后真实工具表、真实单收件人投递，以及手机/Passkey/录音完整链路均未在本次本地优化中验收。没有通过增加日志、导出凭据或发信来绕过这些证据边界。
