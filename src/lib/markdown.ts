import type { ClassSession, TranscriptSegment } from "../types";
import { formatDuration, formatTimestamp } from "./time";

export function buildMarkdownTranscript(session: ClassSession): string {
  const lines: string[] = [
    `# ${escapeMarkdown(session.title)}`,
    "",
    `- 课程：${escapeMarkdown(session.courseName)}`,
    session.courseTerm ? `- 学期：${escapeMarkdown(session.courseTerm)}` : "",
    `- 文件夹：${escapeMarkdown(session.courseFolderName)}`,
    `- 日期：${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(session.startedAt))}`,
    `- 时长：${formatDuration(session.durationMs)}`,
    `- 模型：${session.models.translation} + ${session.models.transcription}`,
    "- 语言：韩语 -> 中文",
    "",
    "## 逐字稿",
    ""
  ].filter(Boolean);

  if (session.segments.length === 0) {
    lines.push("_本节课没有保存到字幕文本。_");
    return lines.join("\n");
  }

  for (const segment of session.segments) {
    appendSegment(lines, segment);
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function buildAiSessionContext(session: ClassSession): string {
  const lines: string[] = [
    `# ${session.title}`,
    "",
    `- 课程：${session.courseName}`,
    session.courseTerm ? `- 学期：${session.courseTerm}` : "",
    `- 日期：${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(session.startedAt))}`,
    `- 时长：${formatDuration(session.durationMs)}`,
    "- 语言：韩语 -> 中文",
    "",
    "## 中韩转录",
    ""
  ].filter(Boolean);

  appendAiTranscript(lines, session);
  return lines.join("\n").trimEnd() + "\n";
}

export function buildAiCourseContext(sessions: ClassSession[]): string {
  const orderedSessions = [...sessions].sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  const firstSession = orderedSessions[0];

  if (!firstSession) {
    return "# 课程上下文\n\n_当前没有已保存的课堂记录。_\n";
  }

  const lastSession = orderedSessions.at(-1) ?? firstSession;
  const lines: string[] = [
    `# ${firstSession.courseName} 课程上下文`,
    "",
    `- 课程：${firstSession.courseName}`,
    firstSession.courseTerm ? `- 学期：${firstSession.courseTerm}` : "",
    `- 课次数：${orderedSessions.length}`,
    `- 时间范围：${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(firstSession.startedAt))} - ${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(lastSession.startedAt))}`,
    "- 语言：韩语 -> 中文",
    "",
    "以下是当前已保存的全部课次中韩转录，按上课时间从旧到新排列。",
    ""
  ].filter(Boolean);

  for (const session of orderedSessions) {
    lines.push(`## ${session.title}`, "");
    lines.push(
      `- 日期：${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(session.startedAt))}`,
      `- 时长：${formatDuration(session.durationMs)}`,
      ""
    );
    appendAiTranscript(lines, session);
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function downloadMarkdown(session: ClassSession): void {
  const markdown = buildMarkdownTranscript(session);
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeFileName(session.courseFolderName)}-${safeFileName(session.title)}.md`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function appendSegment(lines: string[], segment: TranscriptSegment): void {
  const time = formatTimestamp(segment.startedAtMs);
  const chinese = segment.translatedText.trim() || "_无中文译文_";
  const korean = segment.sourceText.trim() || "_无韩文原文_";

  lines.push(`### ${time}`, "", chinese, "", "<details>", "<summary>韩文原文</summary>", "", korean, "", "</details>", "");
}

function appendAiTranscript(lines: string[], session: ClassSession): void {
  if (session.segments.length === 0) {
    lines.push("_本节课没有保存到字幕文本。_", "");
    return;
  }

  for (const segment of session.segments) {
    const time = formatTimestamp(segment.startedAtMs);
    const chinese = segment.translatedText.trim() || "无中文译文";
    const korean = segment.sourceText.trim() || "无韩文原文";
    lines.push(`### ${time}`, "", `中文：${chinese}`, "", `韩文：${korean}`, "");
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
}

function safeFileName(value: string): string {
  return (
    value
      .trim()
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, "-")
      .slice(0, 80) || "class-transcript"
  );
}
