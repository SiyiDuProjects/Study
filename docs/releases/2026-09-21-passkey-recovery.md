# Study 通行密钥恢复发布

用户明确报告原密钥已丢失并要求重新设置。恢复功能已上线；用户亲自创建了汉阳新通行密钥，并已成功登录原账号。双学校 ChatGPT 插件切换仍继续进行，不能以这次网站登录代替客户端验收。

- 候选：`20260921T055943461Z-0c8569c05fda-514df1ed3b2b`。
- 源码 SHA256：`514df1ed3b2b82497d928841b190b9530cefca088aedd0600d5f6c702ac77e3e`。
- Core 归档 SHA256：`956ef9b34069e54c1f1f9ee8bf934d5ba2995386bab0ee10b40edd9d936562e0`。
- 生产镜像：`sha256:33c2229b0e7f709bf20a48bc10b54a95deca55134f8bf409b8fd090dd6ff2970`。
- 前一镜像：`sha256:5e2ae2d4fafbe1469a83fc5015681847223b3c44ed6ec410763bd20df625a4a5`。
- 新鲜备份：`/home/ubuntu/siyi/backups/study-20260921T055943461Z-0c8569c05fda-514df1ed3b2b`，包含旧源码、数据库、配置和镜像标识。配置和凭据未输出。
- `release:check` 通过：Core 266、Record 72、发布工具 11 项，共 349 项；1 项 Sites helper 测试跳过。类型检查、构建、插件及 Skill 校验、Record Worker 冒烟检查通过。
- schema 9 只新增恢复申请表。候选与旧镜像均在升级后的数据库副本启动，严格 `passkey-recovery-v9` 结构校验通过。
- 切换前后数据库 integrity 为 ok；生产内部和公网 readiness 通过。发布后真实读取 Berkeley 16 门、汉阳 7 门课程，无下一页，稳定 profile 与学校扩展隔离检查通过。
- 原两校 UUID、PAT 连接、汉阳 Lecture 所有权保持不变；14 条录音仍可读取，无进行中录音。Record 没有重新发布，之前完整 560 段分页验收见双学校合并报告。

## 恢复边界与实测

`/recover` 创建浏览器绑定的请求；公开 request ID 本身没有恢复权限。秘密仅存于 HttpOnly/Secure/SameSite=Strict Cookie，数据库存哈希。服务器 CLI 在核实原账号和学校后批准，公网没有批准接口。请求最多 30 分钟，批准最多 10 分钟，WebAuthn challenge 另有限时。

成功验证 canonical RP、origin、challenge 及本人操作后，同一事务替换该账号旧通行密钥、撤销该账号网站会话和其他恢复请求。失败、跨浏览器、跨学校、过期、并发或重放都不能完成替换。现有 scoped OAuth 连接保持原权限，学校 PAT 与资料不重建。

汉阳恢复申请由 Codex 内置浏览器发起，服务器管理员批准后由用户本人创建并正常登录。只读元数据核实：恢复已消费；原汉阳 UUID 下有 1 枚 `study.siyidu.com` 凭据，已有成功使用时间；存在有效网站会话。账户页显示原 Hanyang HY-ON 身份及 14 条录音。

用户曾在 Chrome 旧登录页点击旧汉阳入口，得到 `No passkey is registered for this sign-in route`；该结果符合旧 RP 凭据已被新凭据替换。新密钥普通登录已证实成功。

## 后续合并验收

新 Study 插件的汉阳连接已成功，link ID 为 `link_6ab0cbcadde48191a08313f7c1b1466e`。首次连接只申请 `canvas.read`；刷新后 ChatGPT 正确显示课堂记录与发信工具“需要重新连接”。通过插件管理中的重新连接，在用户现场明确允许后补充 `lecture.read` 和 `canvas.messages.write`。回到同一连接后，相应工具的重新连接提示已消失。发送和回复工具保留写入标记，未实际发送任何消息。此证据只证明客户端工具发现和权限状态，自然语言调用仍待验证。

保留 [双学校合并报告](2026-09-21-study-unification.md) 中未完成事项：在同一 ChatGPT 私有 Study 插件连接并验证两校，迁移原汉阳每日任务，再清理旧插件和重复 Berkeley 服务。新 App ID 保持 `asdk_app_6ab0bfacd2188191a0dee9b25994b83a`，没有再次创建插件。

汉阳的 ChatGPT 对话验收已返回原稳定 profile，以及 `list_courses(limit=2)`、`list_lecture_sessions(limit=1)` 成功和分页状态，见对话 `6ab0cea7-f924-83ea-9932-7eb59ba01b86`。原每日任务 `6a9e34ab92488191902f00f7db3ad2c9` 的提示已改为新 Study，运行前校验汉阳 institution 和稳定 UUID，保留原每天 16:00 显示时间、其他频率设置与只读约束。保存成功后重新打开核对。已通过原任务的“立即运行”发起验收；对话 `6a9e347d-b150-83ea-8d57-d8f0206e4f16` 的工具记录显示 Study，并确认正确汉阳 profile，完整任务仍运行中。Berkeley 连接及旧插件清理仍待完成。

恢复设计参考 [OWASP 恢复指引](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html) 和 [SimpleWebAuthn 本人验证要求](https://simplewebauthn.dev/docs/advanced/passkeys)。没有代用户创建通行密钥、改学校密码、发送消息、提交作业或录制音频。

原每日任务手动运行现已完成（turn 79d69623-d758-4c0b-a98a-3d132ddd9b0e，completed，无任务错误），返回当日课程、当前未完成事项与来源。迁移后的提示、新 Study 工具来源、汉阳身份及完成状态均已核实；这不代表每个学校接口都支持所有读操作，也未进行任何写入。

汉阳新连接和原每日任务验证后，按用户此前清理旧插件的要求卸载旧 Hanyang Study（asdk_app_6a83fd77641c8191b3b7d00144ee33e2）；页面已变为安装插件。这是可恢复的卸载，没有永久删除远端 App、学校账号、数据库或本地 Codex 插件。旧 Berkeley 插件与服务保留至 Berkeley 新连接完成。
