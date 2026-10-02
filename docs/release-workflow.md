# Study 发布入口

在仓库根目录使用同一个入口（适用于 macOS、Linux 和 Windows）：

```sh
node scripts/study-release.mjs status
node scripts/study-release.mjs check
node scripts/study-release.mjs prepare
```

这三个命令只负责本地状态、完整校验和候选准备。它们不会连接学校、调用 Sites API、部署服务器、发送消息、启动录音、刷新 ChatGPT 或更新本机插件。

文中的 npm 命令在 macOS/Linux 使用 `npm`；Windows PowerShell 可替换为 `npm.cmd`。

## 三个命令分别做什么

| 命令 | 结果 | 不能据此声称 |
| --- | --- | --- |
| `status` | 本地 Git 版本、改动数量、配置目标、最近校验及候选清单；已有的 `docs/releases/latest.json` 部署回执 | 当前线上版本、全部改动已上线；本地回执不是实时查询，dirty 本身也不能证明未上线 |
| `check` | 生成 canonical MCP Skills；发布工具测试；插件校验；Core 和 Record 类型检查、测试、构建；Record 授权组件预检及 Worker 冒烟检查 | 服务器部署、ChatGPT 可见、真实手机录音正常 |
| `prepare` | 固定本次已验证源码及构建，生成文件 SHA256 清单与两个归档 | 已推送 Sites 源码、已发布网站、已刷新 ChatGPT |

`check` 复用 `build:mcp-skills`、`test:release`、`validate:plugin` 和两侧 npm 脚本。Record 先执行 `check:record-dependencies`，再进行类型检查和测试；使用 `sites:build` 生成正式 Worker/浏览器产物，并执行 `test:worker`，不重复运行包含同一类型检查的 `build`。官方插件/Skill ingestion validator 如有要求，仍由发布者按当前官方工具单独执行，仓库校验不冒充官方审核。

校验结果写到 `.deploy/releases/check.json`。开始一次新校验会先使旧结果失效；失败不会留下可用于准备候选的成功状态。校验期间源码变化会失败。校验后任何纳入清单的源码或构建变化，都需要重跑 `check`，`prepare` 不会偷偷使用旧结果。

## 候选在哪里

每次成功准备产生独立目录：

```text
.deploy/releases/<UTC时间>-<Git提交>-<源码SHA256>/
  manifest.json
  source/                    本次验证源码的目录快照
    apps/core/
    apps/record/
    plugins/study/
    ...
  core-source.tar.gz         Core 源码包，可在服务器上构建
  record-build/              官方 Sites helper 的隔离打包输入
  record-build.tar.gz        官方 helper 生成的构建包
```

`manifest.json` 记录完整文件路径、字节数、SHA256、Git HEAD/dirty 状态、目标标识、校验时间、两个归档 SHA256，以及各交付阶段。源码 SHA256 标识实际工作区内容；存在未提交改动时，不会用 Git HEAD 冒充该内容的版本。

输入使用源码目录及配置文件的明确范围。`.env`/`.env.*`、`.dev.vars`、密钥文件、凭据目录、数据库、日志、原始音视频、`node_modules` 和 `.git` 不进入快照或归档；符号链接和目录 junction 会被拒绝。Skills 目录里的禁止文件会在生成 catalog 前直接阻断校验，避免被生成器嵌入 Core 源码。脚本不读取生产秘密，也不把依赖目录复制进源码包。源码本身仍需正常审查，目录排除规则不是密钥扫描器。

Record 只采用本次 `dist/client`、`dist/server` 和 `dist/.openai`，不会把旧构建残留在 `dist` 根目录的资源一起打包。所有复制都核对校验时的 SHA256；完成前再次确认源码及构建没有变化。失败的目录没有完成的 `manifest.json`，不可发布。脚本不自动删除或覆盖已有候选。

## Record 共享依赖与 Sites 打包

仅更新 Core、且 Record 及其共享源码与最近已发布清单完全一致时，可使用 `npm run release:prepare -- --core-only`。此模式仍要求完整 `release:check`，保留全部源码快照和 Core 归档 hash；不调用 Sites helper，也不生成或部署 Record 包。Record 文件增删改或共享源码变化会阻断此模式。发布者仍须检查内部协议没有变化，并记录保留的 Record 版本；协议变化必须配套发布。

Record 当前会引用 `apps/core/src/lecture/types.ts` 和 `apps/core/src/logger.ts`。`manifest.record.sharedSourceFiles` 从实际相对 import 中列出外部共享源码及 SHA256，`source/` 快照保留这些相邻目录。

**不要只复制 `apps/record` 后就认为 Sites 源码独立完整。** Sites 发布者需要准备含这些共享依赖的精确源码提交，并按现有 Sites 流程保存版本和部署。`prepare` 不做 Git 提交、推送或在线保存；本地构建包也不能替代 Sites 源码来源证明。

使用 `node scripts/release/prepare-sites-source.mjs <候选目录> <已有Sites源码checkout>` 创建独立 `sites-source`，保留旧源码提交历史，并加入此次 Record 和两项共享依赖。检查暂存内容后提交，从该提交构建和打包，再使用 Sites 临时凭据按命令推送。不要编辑旧的 `.deploy/record-site` 脏目录，也不要将授权 `node_modules` 提交进去。

Core 发布脚本为 `scripts/release/core-release.sh`。把候选 Core 包上传为 `/tmp/study-core-<releaseId>.tar.gz`，在 VPS 调用 `prepare <releaseId> <当前镜像ID> <包SHA256>`；它备份数据/配置、构建候选并验证新旧镜像和数据库结构。确认无进行中录音后，先部署支持新旧内部读取协议的 Record，用 `scripts/verify-sites.mjs` 实测两种协议，再调用 Core `activate <releaseId>`。新 Core 显式发送 `X-Study-Lecture-Contract: paged-v1`；旧 Core 不发送该头，继续得到旧格式。回滚时先用 `rollback <releaseId>` 恢复 Core 源码和镜像并保留数据库；验证旧协议后再恢复 Record 对应版本，同时遵守 `DEPLOY_CICD.md` 的缓存客户端和进行中录音限制。

打包直接调用已安装 Sites 插件的 `scripts/package-site.sh`，不会复制或改写其实现。Windows 使用本机 Git Bash；不自动安装软件。无法自动定位 helper 时显式指定：

```powershell
node scripts/study-release.mjs prepare --sites-helper "C:/.../sites/<版本>/scripts/package-site.sh"
```

Record 的 HeroUI Pro 构建还需要现有授权安装环境。不要把商业组件产物或密钥加入源码快照，也不要假定普通的干净 `npm ci` 能替代授权安装步骤。

## 发布完成的判定

### Study 双学校合并的 schema 8

`core-release.sh prepare` 默认仍拒绝任何 schema 变化。本次合并必须显式传入第五个参数 `study-unification-v8`；校验器只接受已审查的 7 → 8 变更：每学校一个连接、固定 Lecture 原账号及一次性绑定触发器，其他既有对象必须完全相同。候选和旧镜像都要在新数据库副本上启动。

Berkeley 导入使用候选中的 `scripts/import-berkeley.mjs`，只读挂载 Berkeley 的新鲜数据库与环境备份，先在 Study 副本验证。它保留原账号 UUID、重新加密 PAT 并更新其密钥相关校验值，复制允许域名的通行密钥；不复制 OAuth grants、sessions、invites。正式导入必须在备份完成后执行，验证两校读取和 Lecture 所有权。回滚保留新数据库，恢复旧 Core 后汉阳旧连接继续使用；Berkeley 暂时回到冻结的旧服务。绝不可用旧数据库覆盖迁移后新增记录。

新插件双账号、原生 Skills 和学校定时任务完成切换前，旧插件与 Berkeley 服务保持可回退；只有一套 Study 源码继续开发。

### 丢失通行密钥后的管理员恢复

schema 9 只新增 `passkey_recovery_requests`，发布校验须显式指定 `passkey-recovery-v9`；旧镜像仍须在新数据库副本启动。恢复页面为 `/recover`，浏览器先申请公开 request ID。服务器管理员核实本人请求、目标账号 UUID 与学校后，在 Core 容器内运行 `node dist/cli/approve-passkey-recovery.js --request <页面公开ID> --user <原账号UUID> --institution hanyang|berkeley`。不能仅凭陌生人提供的 request ID 批准。

公开 ID 不提供恢复权限：批准绑定发起浏览器的 HttpOnly/Secure/SameSite=Strict Cookie，只保存 Cookie 的哈希，不输出或传递恢复令牌。请求最多存活 30 分钟，批准后最多 10 分钟；新凭据必须通过 canonical RP、origin、challenge 及本人验证。成功后在同一事务中消费恢复、替换该账号旧密钥、撤销其网站会话及其他恢复请求，再由用户正常登录。PAT、账号 UUID、Lecture 所有权和既有 scoped OAuth 连接保持不变；没有公开管理员批准 API。

| 阶段 | 必须有的证据 |
| --- | --- |
| 本地完成 | 成功校验，当前源码/构建仍匹配，候选 manifest 及归档 hash |
| Core 服务器部署 | 生产状态检查、新备份、候选构建、回滚启动验证、实际切换、内部和公网健康分别通过 |
| Record Sites 部署 | 精确源码提交、保存版本、对应 deployment 成功；保存版本不等于部署 |
| ChatGPT 刷新 | 目标在线账号中的实际工具/Skill 可见与调用；本机插件安装不等于在线刷新 |
| 真实使用验证 | 对应功能的真实操作证据；未做手机/音频或真实发信测试时明确保留该边界 |

这些阶段按各自证据分别报告。清单中的 `not_recorded` 表示该候选没有在此记录对应交付证据，不是对现有线上状态的判断。部署者将实际版本、部署标识、时间和验证范围记录在同一候选旁的交付记录中；之后询问“是否都上线”时，以这份清单、实际部署状态及客户端验证共同核对。

Core 与 Record 的读取契约变化需要配套发布。生产操作继续遵循 `AGENTS.md` 和 `DEPLOY_CICD.md`；此入口不增加远端 API、另一个发布平台或默认本机插件安装步骤。
