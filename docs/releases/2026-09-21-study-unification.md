# Study 双学校合并发布

状态：Core 与账号数据迁移已上线；新 ChatGPT Study 插件已创建并安装，学校通行密钥登录待本人完成。双账号客户端验收、定时任务切换与旧插件退出尚未完成。

## 固定入口与实现

- 网站与 OAuth：`https://study.siyidu.com`；MCP：`https://study.siyidu.com/mcp`。
- Record 仍为 `https://lecture.siyidu.com`，没有重新部署。
- 一份 Canvas 实现服务两个学校连接；LearningX、导入课表、Lecture 与显式单收件人 Inbox 写操作仅限汉阳。
- 两个学校保留各自 UUID、凭据与 OAuth 授权。新 `get_study_profile` 提供稳定身份及学校标签，不依赖客户端隐藏不适用的工具。
- schema 8 将全库单连接改为每校一个连接，并固定原汉阳 Lecture 所有者。删除账号不能使其他账号接管既有录音。
- Berkeley PAT 在服务器内使用 Study 密钥重新加密；只导入账号、连接与允许域名的通行密钥，没有复制旧 OAuth grants、会话或邀请。

## 发布证据

- 候选：`20260921T051922313Z-0c8569c05fda-2ed678a1d3d9`。
- 源码 SHA256：`2ed678a1d3d9f65bc16f806edd2c4255265b7810a464ecb34e9fa4437819d9e9`。
- Core 包 SHA256：`dce1b65b449ba0cec21ca59ae31c69ffe6b1b12f068c1911849eeb9e577fac18`。
- 生产镜像：`sha256:5e2ae2d4fafbe1469a83fc5015681847223b3c44ed6ec410763bd20df625a4a5`。
- 旧镜像：`sha256:baa17c7db13753e62bc83b084c3ae59076cba5aa37311389bb097f70e5afbaf5`。
- Study 备份：`/home/ubuntu/siyi/backups/study-20260921T051922313Z-0c8569c05fda-2ed678a1d3d9`。
- Berkeley 新鲜备份：`/home/ubuntu/siyi/backups/berkeley-study-unification-20260921T051922313Z-0c8569c05fda-2ed678a1d3d9`。
- Core 260、Record 72、发布工具 10 项测试通过；另有 1 项 Sites 打包测试按 Core-only 流程跳过。两侧类型检查、构建及 Worker 冒烟检查通过。
- 插件和四个 Skill 校验通过，包括官方 quick_validate；最终 App 映射更新后仓库插件校验再次通过。
- 新旧镜像均在 schema 8 数据副本上启动。结构校验只接受已审查的 7 → 8 变化。
- 最终候选导入副本及正式数据库后，Berkeley 读取 16 门、汉阳读取 7 门课程，均无下一页；身份和汉阳扩展隔离检查通过，SQLite integrity 为 ok。
- 生产内部与公网 `/readyz` 均通过。
- Record 完整分页读取：14 条记录、560 段、287 个详情页、0 警告；旧/新读取契约均通过；无进行中录音，未授权浏览器和缺少内部令牌的请求均返回 401。

## 登录与客户端

- Cloudflare `webauthn-ror-bridge` 已发布，版本前缀 `48236e5c`，前版 `68232b70`。用户在现场明确许可后，为 Berkeley 旧 RP 的 origins 增加 Study，并保留原 Berkeley 网站；汉阳原 origins 不变。公网返回已核实。
- `WEBAUTHN_BERKELEY_LOGIN_ENABLED` 与现有 `WEBAUTHN_LEGACY_LOGIN_ENABLED` 均为 true；对应配置有 owner-only 备份。网站显示两校旧通行密钥入口。
- 新 App：`asdk_app_6ab0bfacd2188191a0dee9b25994b83a`，开发者版本 `asdk_app_v_6ab0bfacd224819191734e59bf00170c`，注册地址为固定 Study MCP。已看到“连接另一个账户”，尚未获得两个已授权账户的证据。
- 首次登录请求包含 `canvas.read`。界面说明按操作请求额外作用域；服务端依注册的 refresh_token grant 签发刷新令牌。尚未验证 ChatGPT 中 Lecture 的增量授权和交替调用，不以服务器测试替代客户端验收。
- 原生 Canvas 和 Daily Brief 的正文已保存并重新加载，包含新学校边界。Study（`6a9f1d1bfb248191b776d3f3eacdf66c`）及 Study Lecture（`6a9f1d3a37688191982551e1de6116b5`）的编辑器正文与描述已逐项核对，匹配仓库发布版本，无需重写。Canvas 描述和两校正文再次读取确认已保存；目录卡片仍可能展示生成资源中的旧名称或摘要，不能把卡片显示视为正文未保存。服务器四个 Skill 已由本候选发布。
- 用户提供的 Windows 截图显示当前停在旧汉阳 RP（`canvas.gaid.studio`）的通行密钥选择框，仅列出手机/平板或实体安全密钥，并非网页 OAuth 授权确认页。尚未证明本机有可用凭据，也尚未完成汉阳验证；等待确认原通行密钥所在设备，没有绕过认证或重置凭据。
- 候选固定后才取得真实 App ID；唯一后续插件映射变更为 `plugins/canvas/.app.json`，SHA256 `d9f776c0dad521a6df953f2eafeec0972ce646a78e55a3bac86521600d5b610b`。它不改变已部署的 Core 包，不改写原不可变候选清单。

## 迁移过程中验证到的发布问题

容器运行镜像原来没有运维脚本；现已显式打包并保证目录可遍历。SQLite WAL 的只读校验需要临时辅助文件目录；备份仍只读挂载，辅助文件使用容器内存目录。首次正式切换因管理员专属环境文件读取身份不匹配自动回滚，数据库保留；修正操作身份后重新切换并完成导入。未放宽秘密文件权限。

## 待完成的客户端切换

1. 本人在已打开的 Study 登录页完成汉阳旧通行密钥验证及可选新域名通行密钥创建，再完成 Berkeley 连接。
2. 核实新插件两个稳定 profile、交替读课程、汉阳扩展权限、Lecture 读取和实际自然语言使用。
3. 更新现有“汉阳每日课程检查”（`6a9e34ab92488191902f00f7db3ad2c9`），保留原时间与 Asia/Seoul 课程日期，明确绑定新 Study 汉阳连接。“温欢邮箱检查”经核实仅查邮箱，无插件依赖，保持不变。
4. 按用户新增要求清理旧 Hanyang Study 与 Berkeley Canvas 插件入口；验证新连接前保留旧入口。旧 Berkeley 服务冻结为恢复副本，完成切换后停用重复服务，不能用旧数据库覆盖迁移后的数据。

没有发送学校消息、提交作业、更改学校记录或录制音频。本报告不表示全流程迁移已完成。
