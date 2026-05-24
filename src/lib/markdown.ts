import type { ClassSession, TranscriptSegment } from "../types";
import { formatDuration, formatTimestamp } from "./time";

export function buildMarkdownTranscript(session: ClassSession): string {
  const lines: string[] = [
    `# ${escapeMarkdown(session.title)}`,
    "",
    `- 日期：${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(session.startedAt))}`,
    `- 时长：${formatDuration(session.durationMs)}`,
    `- 模型：${session.models.translation} + ${session.models.transcription}`,
    `- 语言：韩语 -> 中文`,
    "",
    "## 逐字稿",
    ""
  ];

  if (session.segments.length === 0) {
    lines.push("_本节课没有保存到字幕文本。_");
    return lines.join("\n");
  }

  for (const segment of session.segments) {
    appendSegment(lines, segment);
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function downloadMarkdown(session: ClassSession): void {
  const markdown = buildMarkdownTranscript(session);
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeFileName(session.title)}.md`;
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

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
}

function safeFileName(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80) || "class-transcript";
}
