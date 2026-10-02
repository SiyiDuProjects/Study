# Study 学期筛选与 Berkeley 恢复

Berkeley 的真实课程清单复现了旧课持续 active 的原因：16 个可访问站点中，Fall 2025、Spring 2026 课程仍是 available / active，标准学期 endAt 为空。Fall 2026 的正式课程有 3 门，另有独立的 SHAPE 2026–2027 培训；Default Term 不能视为当前学期。

## 实现

- 共享 `list_courses` 新增可选 `term_id`，使用读取到的确切学期 ID 在完整上游分页中筛选，并与 `course_ids` 取交集。继续游标绑定学期筛选，不允许跨学期复用。
- 不假定学生 Courses API 支持管理员接口的 `enrollment_term_id` 参数；筛选在服务内完成，学校端只有 GET。
- 无筛选查询继续用于发现学期，保留旧游标作用域与历史资料访问。服务不把 active 自动解释为当前学期，也不猜测空结束时间。
- Canvas Skill 默认日常请求先按学校本地日期及学期元数据选当前学期，再约束 Planner、日历、作业和周摘要的课程 ID。历史作业只在明确历史查询或用户持续跟踪时带入；培训和非学期站点单独判断。没有硬编码用户当前学期，也没有修改 Canvas 选课、收藏或课程状态。

## 发布与验证

- 候选：`20260921T064410206Z-0c8569c05fda-3f45e39ce1e8`。
- 源码 SHA256：`3f45e39ce1e859a58de1e84c8bfbb14cdb08d73ba7e9ff647cbca7fbc141b603`。
- 归档 SHA256：`50d02e10467e8d915f5aeca89ae170bc228ede615bad8070d1d5a6eb9031e5dc`。
- 生产镜像：`sha256:68c0d289dad2a3b82c3c425d547e0164f37987f3376ce57fcceed2a8c09e0add`；前一镜像 `sha256:33c2229b0e7f709bf20a48bc10b54a95deca55134f8bf409b8fd090dd6ff2970`。
- 新鲜备份：`/home/ubuntu/siyi/backups/study-20260921T064410206Z-0c8569c05fda-3f45e39ce1e8`。候选和前一镜像均能在数据库副本启动，schema 9 无变化。
- 本地 352 项通过：Core 269、Record 72、发布工具 11；1 项 Sites helper fixture 跳过。类型、构建、插件/技能及 Record Worker 冒烟校验通过。
- 发布前后 integrity ok、两校身份和 Lecture 所有权保持不变，14 条记录，无进行中录音。内部与公网 readiness 均通过。Record 不重新部署。
- 线上 MCP 实测：无学期筛选仍可读 16 门；Fall 2026 的 3 门课以每页 2 条完整分页返回；Fall 2025 的 4 门仍能明确查询。线上 Skill 已包含新规则。

## 客户端迁移状态

汉阳新连接、课堂记录权限、发信权限及每日任务的已完成验收沿用 [恢复报告](2026-09-21-passkey-recovery.md)。旧 Hanyang Study 已可恢复地卸载。

用户又报告 Berkeley 原密钥丢失。沿用已发布的恢复机制，仅批准原 Berkeley UUID；用户本人创建并登录。元数据确认原账号下有 1 枚 `study.siyidu.com` 密钥且已有成功使用时间。OAuth 已返回新的 link ID `link_6ab0d32bbb3081919748e0c83445d4cd`，双账户界面和 Berkeley 自然语言验收均已完成。

- 同一个 ChatGPT 私有 Study 插件内可见两个独立连接，已命名为 `Hanyang` 和 `Berkeley`；仅修改昵称，未扩大审批权限。
- 原生 Canvas Skill 已保存并重新加载，全文复制核对与 canonical 正文完全一致，共 7713 字符。工具目录已刷新，`list_courses.term_id` 可见。早前旧标签页报告的扩展浮层阻塞已通过新标签页恢复，不再阻碍交付。
- Berkeley 客户端验收对话：[Berkeley课程只读验收](https://chatgpt.com/c/6ab0d6a6-8ef4-83ea-b668-f76359bb45d3)。读取原 Berkeley profile `c053f580-1dac-4f30-a1fe-33970c796df7`、学校连接状态与 canvas Skill，完整发现 16 个站点后以实际 term ID `5751` 返回 3 门 Fall 2026 正式课程，两个集合均 `nextCursor=null`。SHAPE、Default Term 和历史学期单列；未更改学校记录。
- 旧 Hanyang Study 与 Berkeley Canvas 均已可恢复地卸载，页面显示“安装插件”。没有永久删除远端应用，也没有修改本地 Codex 插件安装。

## 旧服务与登录入口收尾

- 新鲜数据和配置备份：`/home/ubuntu/siyi/backups/study-legacy-retirement-20260921`。Core 与旧 Berkeley SQLite 均经在线备份及 integrity 检查；旧 Berkeley 镜像在隔离数据库副本中成功启动并通过 readiness。
- 旧 `berkeley-canvas-mcp-berkeley-canvas-1` 已停止，原容器、镜像、数据卷及配置保留。只有统一 Study Core 继续承担双校服务和后续开发。
- 两校新密钥均已成功使用后，关闭 `WEBAUTHN_LEGACY_LOGIN_ENABLED` 和 `WEBAUTHN_BERKELEY_LOGIN_ENABLED`。副本验证公开登录配置关闭旧入口；真实浏览器只显示 canonical 登录及恢复链接。两校凭据、OAuth 连接、PAT 和记录所有权未改变。
- 配置操作曾因重启期间的瞬时连接重置自动回退；确认旧配置与内外健康恢复后，采用正式发布相同的有限等待方式重新执行，最终成功。生产镜像和 schema 均未改变。
- 清理后再实测 Berkeley 16 个站点、当前 3 门和历史 4 门查询，数据库 integrity ok、两校身份完整、14 条 Lecture 记录及所有权保留。内部和公网 readiness 分别通过。
- 已将两项回退脚本保存在上述备份目录：需要恢复旧服务时运行 `sh <备份目录>/retire-legacy-berkeley.sh rollback`；需要恢复迁移期登录入口时运行 `sh <备份目录>/disable-legacy-passkey-routes.sh rollback`。不覆盖当前数据库。

## 定时任务双账号回归

汉阳任务仍为 `6a9e34ab92488191902f00f7db3ad2c9`，原时间每天 16:00（界面当地时间，对应韩国次日 08:00）及提醒内容保留。

两个连接都完成、旧插件卸载后的追加运行暴露了客户端未明确选择账号的问题：profile 调用参数为空，客户端报告没有 eligible linked account，并安全停止，未混入 Berkeley 数据。任务现已保存新 Study 应用 ID、汉阳连接 ID `link_6ab0cbcadde48191a08313f7c1b1466e`，要求使用客户端 `link_id` 明确选中该连接，再核对稳定 profile 和学校。

最终重跑已完成：[新建每日课程检查](https://chatgpt.com/c/6a9e347d-b150-83ea-8d57-d8f0206e4f16)。展开最新 profile 调用，实际参数为 `{"link_id":"link_6ab0cbcadde48191a08313f7c1b1466e"}`；成功读取汉阳 2026-2 学期（term 94）的 7 门正式课程，完成课程、未完成作业、公告、LearningX Board、出勤及 Inbox 的当日检查并输出中文简报。学校返回的部分 Quiz 404 和文件目录权限不足如实列为覆盖限制，未补造结果。没有发送消息或修改学校记录。

本次交付已完成：在线私有 Study 插件双连接、四项 Skills、学校定时任务、新网站及旧插件/服务清理均已验收。后台仅关闭临时旧密钥入口，源码与构建仍对应上述已验证候选。消息发送权限已授权并可见，但未为了验收向真实收件人发信；本轮未新增录音或做麦克风测试。

## 用户追加的旧创建记录清理

用户确认卸载后仍可重新安装的旧记录也要清除。本地 `berkeley-canvas@personal` 已由插件管理工具卸载，个人 marketplace 仅移除这一条登记；原始目录备份在 `.deploy/legacy-personal-marketplace-before-cleanup.json`，插件源码保留。统一 Study 本地插件不变。

旧 Berkeley 在线应用 `asdk_app_6a949fe613d48191abe6a5326c960656` 已从“我创建的”列表删除并重新读取列表验证。该界面的删除菜单直接执行，没有预期的二次确认框；已向用户说明。用户现场确认后，旧 Hanyang 应用 `asdk_app_6a83fd77641c8191b3b7d00144ee33e2` 也已删除。刷新个人创建列表后仅剩新的 Study 和原有 Jobs Radar，两个旧学校应用均不再出现。新 Study 在线应用保留，未更改两个连接或定时任务。

接口依据：[Canvas Courses 官方文档](https://developerdocs.instructure.com/services/canvas/resources/courses)。

## 追加的本地文件清理与命名整理

用户随后要求移除未安装的本地 Study 记录和残留文件。`gaid-studio-local` 已通过桌面版配套 CLI 从本地市场来源中移除；`personal` 与 `gaid-studio-local` 的空缓存目录已删除。旧 `C:/Users/Administrator/plugins/berkeley-canvas` 包的身份和边界核对后已移入回收站。统一源码和生产回滚备份保留，没有重新注册或安装本地插件。

统一插件源码目录由 `plugins/canvas` 改为 `plugins/study`，manifest 名称由 `canvas` 改为 `study`；仓库市场声明、构建/发布脚本、发布测试和当前维护文档同步。`.app.json` 仍关联原在线 Study 应用；共享 Canvas Skill 和工具依赖别名保留兼容性。课堂录播明确作为 Study 内的功能，`apps/record` 和包内 `study-lecture` Skill 不构成另一个插件。

本次只修改本地包装与维护路径，未部署新服务：官方插件校验、四项官方 Skill 校验、便携插件及静态目录校验通过；11 项发布测试通过，1 项需要 Sites helper 的 fixture 保持跳过。生成的 MCP catalog SHA256 仍为 `89caf446a59a2c90a0ea45563af1ac33782572fa4e7755f91f0aa1625b070c1e`，与已部署候选中的文件一致。改名后的源码不再匹配之前的完整发布校验；下次生成部署候选前必须重新执行 `release:check`，不将此次局部校验冒充新版本已上线。

用户再次提供仍有本地 Study 卡片的截图后，发现仓库 `.agents/plugins/marketplace.json` 仍保留可安装条目。已移除该条目，保留合法的空 `plugins` 数组；本地目录登记与源码包解耦。校验器允许空目录，仍校验显式登记的路径和元数据并拒绝废弃条目。`validate:plugin` 及静态 MCP catalog 校验通过；桌面版配套 CLI 重新查询 `gaid-studio-local` 的完整可用清单，返回 `installed: []`、`available: []`。此为目录来源与实际清单验证，没有冒充原生桌面界面的视觉验证。
