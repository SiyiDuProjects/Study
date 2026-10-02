# 学校字幕自动同步发布 — 2026-09-08

后台从 Core 的 Hanyang 在读课程及 Weekly Learning 自动发现学校 TransLive。用户从未打开 Record 网站、未点击开关也会初始化课程同步并补齐已有历史。网页复用现有字幕显示，只切换麦克风和学校网络字幕来源；现有 Lecture MCP 可以直接查询。

## 实现与范围

- Weekly Learning 增加独立的学校 viewer ID/URL 和 Canvas moduleItemId；不混用出勤条目 ID。
- Core 使用普通 viewer 权限读取整节历史，保持实时连接，合并半句、定稿、修正与已有中文。重连补齐历史，稳定句子编号避免重复。没有发送录音控制、音频、语言订阅或强制翻译事件。
- D1 追加 0002_school_captions.sql，保存来源和后台课程同步状态。新课程默认检查，明确关闭的课程保持关闭。PAT 仍只在 Core。
- 学校来源不能接管麦克风写入租约，且不阻止用户自己的录音。浏览器读取最近三句，完整历史在记录页和 MCP 中分页查询。
- 本次仅修改该功能所需源码；保留此前已发布的未提交改动。没有安装本机插件，也没有修改或重新发布在线 Skill。

## 版本证据

- 最终候选：20260908T044908360Z-0c8569c05fda-4eb20884025a。
- 源码 SHA256：4eb20884025ab74dc4bcc3388c4941ffc2cb17baa63bd849cd4a8956c684302c。
- Core 镜像：sha256:93db684de88885182ffd73f904ae99a81b3ce1103949a831e80f950a3587d813。
- Record v10：appgprj_6a84ba7dde3c81919d5d4a71c2cbbfff~appgver_116d373ff02c819196c2d149a4eee4c4。
- Record 源码提交：4064f16ee09ef068ba1d4ef70fbaaf35d985523b；对应首个候选 20260908T043357936Z-0c8569c05fda-cb785fdf1dde。最终候选仅进一步修正 Core 的权限提示保留，并增加测试；Record 及其三个共享源文件逐项相同。
- Record 部署：appgdep_6a9f91aecbf48191929dabe38b438326，succeeded，环境 revision 6。
- Record 原始归档 SHA256：4dc7a5ceba5ed076ed12a780e5654b60974562ecc941645cd6de7f7edc541aa8；Sites 规范化归档 SHA256：22e847aaa5b5a4593efa284c80d4b5fd99d843fbe7ecfedcabb307ce2afb306d。
- 入口：https://lecture.siyidu.com；Sites 地址：https://study-record.dusiyi0916.chatgpt.site。

## 当前验证

- Core 227、Record 72、发布工具 6 项测试通过；两侧类型检查、构建、插件及 Skill 校验、真实 workerd/D1 冒烟检查通过。
- 未访问新版生产 Record 网页前，Core 已自行初始化并检查 7 门课程。发现 ESG 两个学校入口及另一门课的一个入口。
- ESG 本节 school_7042679618 自动保存 513 段韩文和中文。与学校现有全文逐句核对：段数、原文、译文及起始时间全部一致，差异为 0。
- 现有 Hanyang Study 连接器实调 list_lecture_sessions 和 get_lecture_transcript，读到来源字段、第 1 句与第 513 句。Weekly Learning 实调也返回两个 viewer 链接和正确模块 ID。
- scripts/verify-sites.mjs 在生产 Core 完整通过：14 条记录分 7 页；560 段字幕分 287 页；warnings=0；新旧列表、详情和搜索通过。无浏览器身份和无内部令牌均为 401。
- 原有 13 条 sessions 和 47 段 transcript_segments 与发布前导出逐字段相同；只新增学校记录。课程缓存与后台状态按设计刷新。
- Core 本地和 canonical 公网 readyz 均通过；环境文件与 Compose 与新备份一致。没有配置或 DNS 变更。

## 备份与回滚

Core 最终备份：/home/ubuntu/siyi/backups/study-20260908T044908360Z-0c8569c05fda-4eb20884025a。

首版功能备份：/home/ubuntu/siyi/backups/study-20260908T043357936Z-0c8569c05fda-cb785fdf1dde。

两次候选均在复制的 SQLite 上启动，再由前版镜像读取候选运行后的数据库。schema_migrations 仍为 7，结构及完整性检查通过。候选设置 STUDY_BACKGROUND_JOBS=off，不触发生产同步。

发布前 Record 四张用户表全列全行导出为 1/7/13/47 行，在内存 SQLite 恢复并逐行核对、检查完整性和外键；SHA256 为 c4b898177f14dc0ad3fa6dc32dc6be78c48828fcf38f47f3b60509f4ee4c7c8f。它是逻辑导出，不是原生 D1 快照。

回滚 Core 时保留新版兼容 Record 和已接收字幕。原功能前 Core 镜像 sha256:4ed452e3ecb6edb9a752c4558a37ed66851369578fc19ec06e0d1e8e4181fdff 的实际 LectureClient 已在临时只读容器中读取新增学校记录成功。缺少来源能力头时，Record 返回旧响应结构。不要删除 D1 新列、表或字幕作为回滚手段。

## 实际限制

两个历史入口需要额外查看权限，后台保留未同步提示；没有绕过学校权限。当前 ESG 学校状态为 pause，513 段是核验时学校已提供的内容，不表示老师已正式结束本节。中文仅接收学校已生成的译文。

本轮验证了学校真实 viewer 数据流、生产后台和已连接 MCP 工具；未运行 ChatGPT 网页/原生客户端交互测试，也未做浏览器视觉验收、麦克风录音或音频上传测试。后台新入口发现约每 5 分钟一次；实时原文通过学校连接更新，已有中文约每 5 秒刷新，网页显示约每 2 秒读取最近字幕。
