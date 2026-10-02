import { useState } from "react";
import { Accordion, Button, Dropdown, Label, ListBox, Select } from "@heroui/react";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { ListView } from "@heroui-pro/react/list-view";
import { Widget } from "@heroui-pro/react/widget";
import { Sheet } from "@heroui-pro/react/sheet";
import { ArrowLeft, BookOpen, ChevronDown, Download, Ellipsis, FileText, Trash2 } from "lucide-react";
import type { ClassSession, ClassSessionSummary } from "../types";
import { teachingWeek, type Timetable } from "../../shared/timetable";
import { displayCourseName } from "../lib/coursePresentation";
import { formatDateTime, formatDuration, formatTimestamp } from "../lib/time";
import { downloadMarkdown } from "../lib/markdown";
import { Notice } from "./SubtitleControls";
import "./RecordHistory.css";

export interface RecordHistoryProps {
  isOpen: boolean;
  showDocument: boolean;
  sessions: ClassSessionSummary[];
  selectedSession: ClassSession | null;
  timetable: Timetable | null;
  errorMessage: string;
  onClose: () => void;
  onBack: () => void;
  onSelect: (session: ClassSessionSummary) => void;
  onArchive: (session: ClassSessionSummary) => void;
  onExport: (session: ClassSessionSummary) => void;
}

export default function RecordHistory(props: RecordHistoryProps) {
  return <Sheet isOpen={props.isOpen} onOpenChange={open => { if (!open) props.onClose(); }} placement="left" isDetached shouldScaleBackground={false}>
    <Sheet.Backdrop variant="transparent"><Sheet.Content className="records-sheet"><Sheet.Dialog aria-label="课堂记录"><Sheet.CloseTrigger aria-label="关闭课堂记录" /><Sheet.Body>
      {props.errorMessage ? <Notice message={props.errorMessage} /> : null}
      {props.showDocument ? <DocumentView session={props.selectedSession} onBack={props.onBack} onExport={downloadMarkdown} /> : <RecordsView sessions={props.sessions} timetable={props.timetable} onSelect={props.onSelect} onArchive={props.onArchive} onExport={props.onExport} />}
    </Sheet.Body></Sheet.Dialog></Sheet.Content></Sheet.Backdrop>
  </Sheet>;
}

function RecordsView({ sessions, timetable, onSelect, onArchive, onExport }: {
  sessions: ClassSessionSummary[];
  timetable: Timetable | null;
  onSelect: (session: ClassSessionSummary) => void;
  onArchive: (session: ClassSessionSummary) => void;
  onExport: (session: ClassSessionSummary) => void;
}) {
  const [courseId, setCourseId] = useState("all");
  const [week, setWeek] = useState("all");
  const courseChoices = Array.from(new Map(sessions.map(session => [session.courseId, { id: session.courseId, name: displayCourseName(session.courseName) }])).values());
  const visible = sessions.filter(session => (courseId === "all" || session.courseId === courseId) && (week === "all" || String(teachingWeek(timetable, session.courseId, session.startedAt)) === week)).sort((a,b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return <section className="records-view">
    <div className="records-heading"><h1>课堂记录</h1><span>{visible.length} 条</span></div>
    <div className="record-filters">
      <Select aria-label="筛选课程" className="record-filter" value={courseId} onChange={value => setCourseId(String(value))}><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger><Select.Popover><ListBox><ListBox.Item id="all" textValue="全部课程">全部课程<ListBox.ItemIndicator /></ListBox.Item>{courseChoices.map(course => <ListBox.Item key={course.id} id={course.id} textValue={course.name}>{course.name}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover></Select>
      <Select aria-label="筛选教学周" className="week-filter" value={week} onChange={value => setWeek(String(value))}><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger><Select.Popover><ListBox><ListBox.Item id="all" textValue="全部周次">全部周次<ListBox.ItemIndicator /></ListBox.Item>{Array.from({length:timetable?.teachingCalendar?.weeks ?? 0},(_,index) => <ListBox.Item id={String(index+1)} key={index} textValue={"第 " + (index+1) + " 周"}>第 {index+1} 周<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover></Select>
    </div>
    {visible.length === 0 ? <EmptyState className="records-empty"><EmptyState.Header><EmptyState.Media variant="icon"><BookOpen /></EmptyState.Media><EmptyState.Title>{sessions.length ? "没有符合条件的记录" : "还没有课堂记录"}</EmptyState.Title><EmptyState.Description>{sessions.length ? "试试其他课程或周次。" : "结束录制后，双语字幕会保存在这里。"}</EmptyState.Description></EmptyState.Header></EmptyState> : <ListView aria-label="课堂记录列表" items={visible} selectionMode="none" variant="secondary" onAction={id => { const session=visible.find(item=>item.id===id); if(session) onSelect(session); }}>
      {session => <ListView.Item id={session.id} textValue={displayCourseName(session.courseName) + " " + formatDateTime(session.startedAt)}><ListView.ItemContent><span className="record-document-icon"><FileText size={19} /></span><div className="record-row-text"><ListView.Title>{displayCourseName(session.courseName)}</ListView.Title><ListView.Description>{formatDateTime(session.startedAt)}{session.source ? " · 学校字幕" : ""}{teachingWeek(timetable,session.courseId,session.startedAt) ? " · 第 " + teachingWeek(timetable,session.courseId,session.startedAt) + " 周" : ""} · {formatDuration(session.durationMs)}</ListView.Description>{session.status !== "ready" || session.finalizationWarning ? <span className="record-warning">{sessionStatusLabel(session.status,session.finalizationWarning,Boolean(session.source))}</span> : null}</div></ListView.ItemContent><ListView.ItemAction><Dropdown><Button isIconOnly size="sm" variant="ghost" aria-label={"记录操作："+displayCourseName(session.courseName)}><Ellipsis size={18} /></Button><Dropdown.Popover placement="bottom end"><Dropdown.Menu aria-label="记录操作" onAction={key => { if(key === "export") onExport(session); if(key === "archive") onArchive(session); }}><Dropdown.Item id="export" textValue="导出 Markdown"><Download size={16} /><Label>导出 Markdown</Label></Dropdown.Item>{session.status === "ready" ? <Dropdown.Item id="archive" textValue="归档记录" variant="danger"><Trash2 size={16} /><Label>归档记录</Label></Dropdown.Item> : null}</Dropdown.Menu></Dropdown.Popover></Dropdown></ListView.ItemAction></ListView.Item>}
    </ListView>}
    <p className="calendar-note">首尔时间 · 按校历教学周整理</p>
  </section>;
}

function DocumentView({ session, onBack, onExport }: { session: ClassSession | null; onBack: () => void; onExport: (session: ClassSession) => void }) {
  if (!session) return <section className="records-view"><EmptyState><EmptyState.Header><EmptyState.Title>选择一条课堂记录</EmptyState.Title></EmptyState.Header><EmptyState.Content><Button variant="outline" onPress={onBack}>返回记录</Button></EmptyState.Content></EmptyState></section>;
  return <section className="document-view"><Button variant="ghost" onPress={onBack} className="back-link"><ArrowLeft size={16} />返回课堂记录</Button><div className="page-heading"><div><h1>{displayCourseName(session.courseName)}</h1><p>{formatDateTime(session.startedAt)} · {formatDuration(session.durationMs)} · {sessionStatusLabel(session.status, session.finalizationWarning, Boolean(session.source))}</p></div><Button variant="outline" onPress={() => onExport(session)}><Download size={17} />导出 Markdown</Button></div>
    {session.source ? <p className="muted">来源：<a href={session.source.viewerUrl} target="_blank" rel="noreferrer">Hanyang 学校字幕</a> · 最近同步 {formatDateTime(session.source.lastSyncedAt)}</p> : null}
    {session.finalizationWarning ? <Notice message={"字幕完整性警告：" + session.finalizationWarning} warning /> : null}
    <Widget className="document-widget"><Widget.Header><Widget.Title>课堂逐字稿</Widget.Title><Widget.Description>{session.segments.length} 段字幕</Widget.Description></Widget.Header><Widget.Content><div className="document-body">{session.segments.length === 0 ? <EmptyState><EmptyState.Header><EmptyState.Title>还没有字幕文本</EmptyState.Title><EmptyState.Description>这条记录中尚未保存字幕。</EmptyState.Description></EmptyState.Header></EmptyState> : session.segments.map(segment => <article className="transcript-block" key={segment.id}><time>{formatTimestamp(segment.startedAtMs)}</time><div><p className="zh-text" lang="zh">{segment.translatedText.trim() || "无中文译文"}</p><Accordion className="source-accordion"><Accordion.Item><Accordion.Heading><Accordion.Trigger>韩文原文<Accordion.Indicator><ChevronDown size={15} /></Accordion.Indicator></Accordion.Trigger></Accordion.Heading><Accordion.Panel><Accordion.Body><p lang="ko">{segment.sourceText.trim() || "无韩文原文"}</p></Accordion.Body></Accordion.Panel></Accordion.Item></Accordion></div></article>)}</div></Widget.Content></Widget>
  </section>;
}

function sessionStatusLabel(status: ClassSessionSummary["status"], warning: string | null, school = false): string {
  const base = { recording: school ? "同步中" : "录制中", ready: "已结束", failed: "待恢复", archived: "已归档" }[status];
  return warning ? `${base}（字幕可能不完整）` : base;
}

