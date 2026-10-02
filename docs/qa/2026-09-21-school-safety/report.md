# 学校插件可靠性审查 — 2026-09-21（韩国时间）

> 以下为修复前的历史审查结果。后续实现与验收见 [修复验证](./fix-validation.md)；原探针结果保留作为缺陷证据，不代表修复后的当前行为。

结论：当前不能把插件的“没有待办／没有逾期”当作可靠的全量结论。截图对应问题已在线上只读复现，另有状态、数据校验、日期和资料保留方面的可复现缺口。学校数据、生产程序、权限配置均未修改；本次只新增审查材料。

## 1. 截图事件：线上实证

对象：韩语听说 2，`제2주차 과제`，课程 `215704`，作业 `2807918`。

[学校作业页](https://learning.hanyang.ac.kr/courses/215704/assignments/2807918)

| 同一作业的查询入口 | 本次线上返回 |
| --- | --- |
| 不带 bucket 的完整作业列表 | 找得到；`missing=true`、`workflowState=graded`、0 分、无提交时间 |
| 单项提交详情 | 同样确认 missing、0 分、未记录提交时间 |
| `bucket=overdue` | `items=[]`、`nextCursor=null` |
| `bucket=upcoming` | 只有第 3 周作业，没有第 2 周 |
| Planner，9/1–9/28 韩国时间，包含完成项 | 第 2 周作业被标为 `completed=true`、`submissionStatus=graded` |
| 同一 Planner 窗口，排除完成项 | 第 2 周作业消失 |

截止时间为 `2026-09-20T14:59:59Z`，即韩国时间 **9 月 20 日 23:59:59**。本次读取仍是上述未交状态。`lockAt=null` 不能证明现在可补交，见 F4。

这是两条独立的漏报路径：上游 bucket 结果不能代表完整未交集合；本地 Planner 归一化又把 graded 放在 missing 之前，并过滤 completed。没有原始 ChatGPT 会话调用日志，因此不能断言历史那一轮具体执行了哪个参数组合，但当前已重现截图描述的 bucket 漏报，并证实额外的 Planner 误判。

## 2. 按风险归并的发现

### F1 / P1：未交、已评分、Planner 完成混为一谈，缺少完整清查路径

- 位置：`apps/core/src/canvas/client.ts:335`、`:854`、`:1226`；`apps/core/src/mcp/canvasTools.ts:165`。
- 复现：P01、P02、P03、P12；上述真实作业在线上表现一致。
- `plannerSubmissionStatus` 先判断 graded，后判断 missing；`normalizeUpcomingWork` 把 graded 变成 completed；默认查询过滤 completed。相反，Submission 的归一化先判断 missing。
- Planner 手动勾选完成也被混进 completed，但没有单独暴露勾选来源。调用者只能看到可能矛盾的状态，难以复核。
- `list_assignments` 直接传递 bucket；工具描述没有明确指出完整未交清查必须省略 bucket。Skill 只规定正确使用提交详情，没有规定先完整枚举每门课的所有作业。
- 实际详情还有 `hasSubmittedSubmissions=true`，但当前学生未交。该字段指任意学生有过提交，并非当前学生，应该明确标注或避免在个人待办模型里歧义展示。[Canvas Assignment 定义](https://developerdocs.instructure.com/services/canvas/resources/assignments)
- 修复验收：七门课逐页枚举无 bucket 作业，结合自己的 submission 状态；missing、重交要求、未知状态不能因为 graded 或 Planner 勾选被隐藏。完成、评分、缺交、豁免、手动勾选应分别保留。

### F2 / P1：教师要求重交的标记被丢弃

- 位置：`apps/core/src/canvas/client.ts:363`；`apps/core/src/mcp/canvasOutputSchemas.ts:160`。
- 复现：P05。上游返回 `redo_request=true`，工具输出只剩 graded/提交时间等字段，没有重交事实。
- 影响：已经交过并评分的作业若被老师退回要求重交，依赖输出的待办筛选可能误删它。
- 这是本地确定的信息丢失；本次没有发现或声称当前真实课程已发生重交漏报。`redo_request` 的含义由官方 Submission 定义确认。[官方文档](https://developerdocs.instructure.com/services/canvas/resources/submissions)
- 修复验收：在详情、列表、历史及 MCP 输出中保留重交标记，并覆盖 graded + redo_request 的场景。

### F3 / P1：异常或身份不匹配的数据可通过工具校验，变成错误事实

- 位置：`apps/core/src/canvas/client.ts:323`、`:363`、`:601`、`:874`、`:1321`；`apps/core/src/mcp/canvasOutputSchemas.ts:160`。
- 复现：P06、P07、P08、P09、P13。空对象 `{}` 被转成 `status=unsubmitted`，并通过实际 MCP `tools/call` 返回 `ok=true`；缺 ID 的列表行也通过 schema。
- 请求作业 8，模拟上游返回作业 999 / 课程 666 时没有拒绝。提交详情含另一个 assignment_id、user_id 时，也会被请求参数重新标成当前查询的作业。
- 影响：上游结构变化或错误路由可能造成假未交、假已交、错归课程。**这是防御校验缺口，不是已证实的跨账号泄露。**
- 修复验收：必需身份与状态字段在归一化前验证；出现明确的身份矛盾应失败；未知不能默认未提交。允许上游合法省略的字段须逐项定义，不能随意全部设为必填。

### F4 / P2：没有足够信息判断能否提交或补交

- 位置：`apps/core/src/canvas/client.ts:988`；`apps/core/src/mcp/canvasOutputSchemas.ts:194`。
- 复现：P04；线上确认当前输出只保留 unlockAt/lockAt，没有用户锁定信息。
- 上游 `locked_for_user`、`lock_info`、`lock_explanation`、尝试次数限制等没有进入输出。因此“lockAt 为空，所以还能补交”证据不足。模块前置条件、手动锁定、尝试次数也可能限制操作。[官方 Assignment 定义](https://developerdocs.instructure.com/services/canvas/resources/assignments)
- 修复验收：保留适用字段；无充分证据时返回“是否仍可提交未知”，并区别学校技术入口可用与教师是否接受迟交。

### F5 / P2：公告发布时间被写成截止时间

- 位置：`apps/core/src/canvas/client.ts:1243`。
- 复现：P14；线上公告 `514533` 针对 9/21 的课程，`postedAt=2026-09-06T06:52:12Z`；Planner 同时把这个时间写入 `date` 和 `dueAt`。
- 原因：无 due_at 就统一回退 plannable_date，未按 announcement、assignment 等类型区分。
- 影响：调用者若把 dueAt 用于逾期或提醒排序，会把通知发布时间误当成任务截止时间。
- 修复验收：仅有明确截止语义才填 dueAt；发布时间、生效日期、计划显示日期分别处理，不能从标题自动编造截止时间。

### F6 / P2：清除 URL 的所有 query 会破坏合法资料入口

- 位置：`apps/core/src/content.ts:24`。
- 复现：P10。`https://school.example/view?id=27` 被改为 `https://school.example/view`。
- 这是本地已复现的数据损失；没有声称某一真实学校问卷已因此打不开。
- 修复验收：秘密参数仍应移除；非秘密的资源定位参数按受控规则保留，或者保留安全资源 ID。无法安全保留时标记链接不可直接使用，不能给出看似正常但指向错误资源的 URL。

### F7 / P2：嵌入式要求被删除，没有遗漏提示

- 位置：`apps/core/src/content.ts:10`、`:69`。
- 复现：P11。正文中 iframe 嵌入的学校 PDF/文件预览被整个删除，既没有安全文件引用，也没有“存在未读取内容”标记。
- 删除可执行 HTML 本身正确；问题是同时失去资料发现线索，可能把“不完整正文”当作“完整要求”。
- 修复验收：继续禁止执行 iframe/script；对受支持的学校文件嵌入保留安全 ID/只读引用，对其他省略内容返回覆盖缺口。

## 3. 已执行的检查与证据边界

| 范围 | 结果 | 边界 |
| --- | --- | --- |
| 当前 7 门课完整 assignments + 自己的 submissions | 23 项逐项对上，所有这 14 个集合的 nextCursor 均为空 | 证明两套作业清单一致，不代表公告、外部测验、课堂口头要求都已清查 |
| 原有 Core 测试 | 227 / 227 通过 | 不覆盖上述状态组合，不能用通过数否定本次缺陷 |
| 原有 Record 测试 | 72 / 72 通过 | 没有做真实手机录音或全历史字幕逐字比对 |
| Core / Record 类型检查 | 通过 | 没有修改产品代码，无需用重建冒充线上验证 |
| 发布工具测试 | 6 通过、1 跳过 | 跳过的是官方 Sites helper 集成场景 |
| 插件与 Skills 校验 | 通过，4 Skills / 8 文件的本地生成快照一致 | 不是官方在线导入验收 |
| 新增合成边界探针 | 21 项，7 个安全断言满足、14 个不满足 | 14 个失败包含同一缺陷的多层复现，归并为以上 7 组；不是 14 起线上事故 |
| 实际 MCP 合成调用 | 重现假空列表、空 submission 假成功；无时区时间输入被拒绝 | 使用模拟数据和 InMemoryTransport，学校网络调用 0 次 |
| 分页与错误处理 | 本地跨页、跨课程游标拒绝、403 不转空、未知成绩不转 0 均通过 | 恶意/结构异常的全部可能形状不可能穷尽 |
| 线上 Inbox / Lecture 分页 | 各读取两页，无重复 ID；Lecture 无 warnings | 两者仍有下一页，本次未声称遍历完所有历史；未发送消息或启动录音 |
| 线上公告 / Weekly Learning / Board | 韩语听说课程：6 条公告、16 个周模块、Q&A 页正常返回总数 0 | 只验证读取与数据语义，未替用户执行整套当日提醒 |
| 线上考勤 | 自动发现两个入口时报歧义；读取 tabs 后选 Lecture/Attendance 138，返回 3 项；未知 completed 保持 null | Offline Attendance 148 是不同页面，未审计其完整性；不能把未来会议的 none 当缺勤 |
| 线上课表 | 7 个会议，Asia/Seoul，明确为 8/30 导入的课表 | 导入基线不是实时调课事实；仍需同课程通知的生效日期 |
| 线上测验 | 韩语听说课返回明确 404；tabs 未显示原生 Quiz 入口 | 不等于课程没有考试；外部工具和课堂安排仍须独立查询 |
| 消息与凭据边界 | 现有测试验证单收件人、独立 write scope、同 request_id 并发不重复发、未知结果不自动重发、Inbox 不标已读、跨域凭据路由和日志保护 | 只验证本地保护；本次真实学校写操作为 0，不做真实发信验收 |
| 线上 Skill | 远端 get_study_skill 的 canvas 与 daily-brief 正文同仓库一致（仅归一化换行/首尾空白） | 未查看 ChatGPT 原生 Skill 编辑器快照或截图会话是否实际加载 Skill |
| 当前部署文件哈希 | 未完成 | Windows SSH 因指定密钥权限过宽拒绝使用；未改密钥 ACL。已有本地发布回执不是实时线上证明 |

## 4. 修复顺序与放行要求

1. 先修完整作业清查与状态模型：无 bucket 枚举所有当前课程，逐页处理；保留 missing / graded / redo / excused / submitted / Planner override 的独立含义。学校上游 bucket 不作为完整性证明。
2. 再修异常数据验证、用户锁定与重交字段、日期语义和资料省略提示。错误或未读部分必须可见。
3. 增加结构化覆盖结果：列出查过的课程、来源、窗口、剩余游标、失败与缺失内容；没有完成清查不能产生全量 all-clear。这比只在 Skill 加一句“不要漏”更可检验。
4. 将本报告复现转为常规回归测试；用模拟工具验证模型是否在 graded + missing、旧通知新生效日、部分来源 403/404、分页尚未结束时仍给出正确提醒。现有规则文案和工具单测不等价于模型端到端合格。
5. 按仓库正式发布流程备份、准备固定候选、验证回滚；再用当前真实作业验证线上列表/详情/Planner 的一致性，并验收目标 ChatGPT 的实际回答。不能只本地改完就宣称交付。

本次为分析审查，**以上产品缺陷尚未修复或部署**。建议把 F1–F3 作为下一次学校插件发布的阻断项。

## 5. 可重跑材料

- [探针源文件](./probe.mts)：只使用模拟 fetch，不读取凭据、不调用学校。
- [完整探针结果](./probe-results.json)：保留输入场景对应的实际输出。
- [最小化线上证据](./live-evidence.json)：只保留计数、状态、目标作业和覆盖信息，不保存邮件正文、账号资料或游标。

在仓库根目录运行：

```powershell
node --import ./apps/core/node_modules/tsx/dist/loader.mjs docs/qa/2026-09-21-school-safety/probe.mts
```

探针记录当前实现行为，不纳入常规 CI；输出中的 passed 表示安全期望是否满足。修复时应改为常规断言式回归测试，不应只修改输出期望让当前错误通过。
