> 历史检查记录：文中的“未部署”指当时状态。2026-09-07 全量发布已完成，当前状态见 [统一发布记录](../../releases/2026-09-07-current.md)。

# Lecture/Attendance 考勤列表读取修复

2026-09-07。用户截图及实际登录页面显示课程 `215729` 的 Lecture/Attendance 有两项视频，全部 attended；现有生产插件使用同一外部工具 `138`，仍返回成功的空列表。问题已定位到客户端使用的读取路径与当前学生考勤页面不同。

## 可核对的证据

| 证据 | 观察 |
| --- | --- |
| 实际登录页面 `/courses/215729/external_tools/138` | 两项视频、attended 2、absent 0、incomplete 0；嵌入页为 `/learningx/lti/lecture_attendance/course_menu` |
| 第一段视频的页面详情 | 24:03、学习完成率 100%、Complete、attended。只打开考勤详情，没有播放媒体或修改进度 |
| 现有生产 `get_learningx_attendance_item(1260902)` | completed=true、attendanceStatus=attendance、progressSeconds=1443.34，与页面详情一致 |
| 现有生产 `list_learningx_attendance`，明确工具 ID 138 | 仍为 `[]`。选择正确 LTI 入口不会自动更换客户端硬编码的 API 路径 |
| 页面加载的官方脚本 | 学生考勤表读取 `attendance_items` 和 `attendance_items/summary`，没有在这条路径使用 `allcomponents_db` |

官方脚本来源为实际嵌入页的 `script[src]`，使用无凭据 HTTP 下载后只作源码分析，没有执行下载的脚本：

- [course-menu.app.js](https://learning.hanyang.ac.kr/learningx/js/LectureAttendance/course-menu.app.js)：入口读取页面 data-role 及显示模式，实际页面 role=1、default_total_attendance=1。
- [commons.js](https://learning.hanyang.ac.kr/learningx/js/commons.js)：模块 23850 选择学生表 88685；模块 20356 定义请求；表格模块 75968 按考勤开关筛选并按条目 ID 读取汇总状态。

下载时的字节数、SHA256 及最小化页面观察记录保存在 [attendance-page-evidence.json](./attendance-page-evidence.json)。

学生表的读取路径为：

1. `GET /learningx/api/v1/courses/{course}/attendance_items?include_detail=true`，读取对象中的 `attendance_items` 数组。
2. `GET /learningx/api/v1/courses/{course}/attendance_items/summary?only_use_attendance=true`，读取对象中的 `attendance_summaries`，以条目 ID 为键。
3. 表格只显示启用 `use_attendance` 的条目，考勤状态来自匹配的 summary。页面这条读取链没有分页参数或续读逻辑。
4. 这门课显示的是两个视频，但表格还支持 `smart_attendance` 等类型，不能把整个集合定义为仅含在线视频。保留条目类型；此集合也不能证明另一个 Offline Attendance 页面完整或为空。

`allcomponents_db` 属于共享脚本中的另一组旧课程内容读取函数，不能用它的空集代表当前 Lecture/Attendance 页面。无需猜测身份参数，也不需要给旧端点增加回退层。

## 实现范围

Core 的 `listAttendance` 改用上述两次 GET，删除旧的 `allcomponents_db` 调用及其额外 Canvas profile 读取。输出继续使用既有 `LearningXAttendanceItem`，按条目 ID 合并真实考勤状态，保留完成状态与考勤状态的区别，不根据 attended 猜测 completed。

根结构、条目身份、考勤开关和汇总记录经过校验；不符合契约的内容返回安全错误，不能伪装成“没有考勤”。类型归一化补充该列表使用的 `item_content_type` 字段，仍优先保留更细粒度的内容类型。没有新增工具、权限、凭据存储、媒体读取或生产配置。MCP 描述与 Canvas Skill 同步区分 Lecture/Attendance 条目、周学习内容及另一个线下点名页面的证据范围。

## 验证与发布边界

Core 的 **204 项测试全部通过**，其中 LearningX **45 项**，比修复前增加 12 项；类型检查、构建、仓库插件校验及官方 Plugin/Canvas Skill 校验均通过。[机器测试报告](./attendance-core-tests.json)保留完整结果。

新增协议样本只在正确的新端点及查询参数下提供考勤条目和汇总，旧端点返回空，其他未预期调用直接失败；覆盖两项已出席视频、非考勤视频及已完成作业的排除、汇总状态覆盖、未知完成状态、异常响应、条目与课程身份，以及无媒体/进度写入。

测试使用按官方页面代码构造的协议样本，不能称为生产原始响应录制。浏览器直接导航到 API JSON 被客户端阻止，未绕过该限制；因此没有声称取得新接口的认证原始响应或完成新代码的线上调用。

本次尚未部署 Core。生产插件的空列表在后端发布并验证前仍可能存在；本机插件说明更新也不等于后端发布。生产部署需要与此前尚未发布的 Core/Record 改动一起明确范围，按仓库要求备份、验证健康及保留回滚。
