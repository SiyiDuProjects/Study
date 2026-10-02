# 2026-09-21 学校插件可靠性修复

截图中的已评分缺交作业现在能够出现在逾期和未完成查询中。此次修复同时覆盖重交标记丢失、异常数据伪装成有效记录、用户锁定信息不足、公告日期误作截止时间，以及链接和嵌入资料清理时的信息损失。实现和测试映射见 [修复验收](../qa/2026-09-21-school-safety/fix-validation.md)。

## 固定候选与上线

- 发布 ID：`20260921T034417418Z-0c8569c05fda-20f0c5fde4a9`。
- 清单：`.deploy/releases/20260921T034417418Z-0c8569c05fda-20f0c5fde4a9/manifest.json`。
- 源码 SHA256：`20f0c5fde4a9a077c4231a642d6fd680cd012f4a011ca36412787412966a2063`。工作区原有未提交改动保留；仅以实际源码清单标识候选，不以 Git HEAD 冒充内容。
- Core 归档 SHA256：`d92a66d636596d070c3034f4df5328199d988fb678e009cd5eae130be18aeeaa`。
- 新镜像：`sha256:baa17c7db13753e62bc83b084c3ae59076cba5aa37311389bb097f70e5afbaf5`。
- 旧镜像：`sha256:93db684de88885182ffd73f904ae99a81b3ce1103949a831e80f950a3587d813`。
- 新备份目录：`/home/ubuntu/siyi/backups/study-20260921T034417418Z-0c8569c05fda-20f0c5fde4a9`。数据库完整性通过、schema=7；保存配置、Compose、源码和旧镜像。
- 候选镜像在数据库副本上启动成功；旧镜像在候选使用过的数据库副本上启动成功；schema 完全相同。已验证数据保留型回滚，不在真实生产库上做破坏性演练。
- 激活成功，内部 `127.0.0.1:8794/readyz`、公网 `study.siyidu.com/readyz`、ChatGPT 现有连接域名 `canvas.gaid.studio/readyz` 均正常。配置和 Compose 与新备份完全相同。
- 激活前再次确认正在录音集合为空、没有后续页和警告。
- Record 保留此前版本 10。本次未改 Record 及其三个共享源码，未改 Core/Record 内部协议；`--core-only` 在打包时检查这些源码与上次发布一致。没有重新部署 Record。

如需回滚，在服务器执行 `sh /tmp/study-core-release-20260921.sh rollback 20260921T034417418Z-0c8569c05fda-20f0c5fde4a9`。备份目录内亦保存同一脚本；回滚恢复旧 Core 镜像/源码并保留当前数据库。

## 真实只读验收

验收时间约为 `2026-09-21T03:47Z`–`03:49Z`。最小化结果见 [上线后证据](../qa/2026-09-21-school-safety/post-release-evidence.json)。

- 课程 `215704` 的作业 `2807918`：overdue 找到该作业；未完成 Planner 返回 `completed=false`、`submissionStatus=missing`，同时保留 `graded=true`、`submitted=false`。单项详情保留 `workflowState=graded`、`missing=true`、0 分、无提交时间。
- 详情新增 `lockedForUser=false`、`allowedAttempts=2`。这不能替代老师是否接受迟交的要求，也未替用户尝试提交。
- 公告 `514533` 保留 `date=2026-09-06T06:52:12Z`、`dueAt=null`，不再制造截止时间。
- 七门当前课程的全量 assignments 与自己的 submissions（包括历史）均读取完成，共 23 项、14 个集合无下一页，关键状态和身份逐项一致。当前 `redoRequest=true` 的记录为 0；合成重交测试不是学校对用户的新要求。
- 录音列表上线后真实读取 2 项成功，无警告、有后续页；这是兼容性抽查，非全历史验证。
- 线上 `get_study_skill` 的 canvas 和 daily-brief 均与 canonical 文件一致（仅规范换行和首尾空白后比较）。

## ChatGPT 在线交付

已在目标账号的现有 Hanyang Study 开发者模式连接执行 Refresh，界面重新展示新版 `list_assignments`、`get_assignment`、`get_upcoming_work` 描述及 bucket 输入说明。

官方文档分别说明了 [开发者模式连接刷新](https://developers.openai.com/plugins/deploy/connect-chatgpt) 和 [已发布插件的 Skill 快照更新](https://developers.openai.com/plugins/deploy/submission)。本账号还有独立的原生 Skill；其更新验收单独记录，不以服务器读取替代。

已通过账号现有编辑器同步并保存两个原生 Skill：Canvas `6a9f1c63174881919332d2db04eb306c`、Daily Brief `6a9f1e12a6b881919a8dd19cdb27b93e`。每日提醒刷新页面后、Canvas 离开再重新打开后，完整正文与此次 canonical 正文一致（规范编辑器空白后比较）；全量查询、缺交/重交、未知状态、锁定和省略内容规则实际可见。没有创建重复 Skill、扩大权限或修改定时任务。

## 本地检查与边界

Core 256 项、Record 72 项、发布工具 8 项通过；Sites helper 专用集成测试跳过 1 项。两侧类型检查、构建、Worker 冒烟、插件校验和修改 Skill 的 quick_validate 均通过。校验时间 `2026-09-21T03:43:58.813Z`。

跨课程全量要求清查仍需要执行 Skill 工作流，工具只提供当前查询的覆盖事实。没有把一次检查表述为学校全部功能没有 bug。没有模拟模型的所有可能回答，也未进行新 ChatGPT 对话的自然语言端到端测试、真实手机录音、音频上传或发信测试。学校写操作为 0。本机插件缓存没有更新，定时任务时间没有修改。
