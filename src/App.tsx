import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  Library,
  Mic,
  Pause,
  Play,
  Settings,
  Square,
  Trash2,
  X
} from "lucide-react";
import { COURSES, DAILY_COURSE_ID, type CourseOption } from "../shared/courses";
import type {
  AppSettings,
  ClassSession,
  ClassSessionSummary,
  ConnectionStatus,
  RealtimeTranscriptDelta,
  RealtimeTranscriptSegment,
  TranscriptState
} from "./types";
import {
  createRealtimeClientSecret,
  deleteRemoteSession,
  fetchCourses,
  getRemoteSession,
  listRemoteSessions,
  saveRemoteSession
} from "./lib/api";
import { createId } from "./lib/id";
import { downloadMarkdown } from "./lib/markdown";
import { RealtimeTranscriptionTranslationClient } from "./lib/realtimeTranscriptionTranslation";
import { RealtimeTranslationClient } from "./lib/realtimeTranslation";
import {
  appendTranscriptSegment,
  applyTranscriptDelta,
  commitActiveSegment,
  createTranscriptState,
  getAllSegments,
  getDisplaySegments
} from "./lib/transcriptReducer";
import { defaultSettings, loadSettings, saveSettings } from "./lib/storage";
import { formatDateTime, formatDuration, formatTimestamp } from "./lib/time";

type ViewMode = "live" | "records" | "document";
type LiveSubtitleClient = Pick<RealtimeTranslationClient, "start" | "pause" | "resume" | "stop">;

const COMMIT_DELAY_MS = 1800;

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [courses, setCourses] = useState<CourseOption[]>(COURSES);
  const [selectedCourseId, setSelectedCourseId] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [viewMode, setViewMode] = useState<ViewMode>("live");
  const [sessions, setSessions] = useState<ClassSessionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<ClassSession | null>(null);
  const [transcriptState, setTranscriptState] = useState<TranscriptState>(createTranscriptState);
  const [startedAt, setStartedAt] = useState<Date | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const clientRef = useRef<LiveSubtitleClient | null>(null);
  const transcriptRef = useRef<TranscriptState>(transcriptState);
  const commitTimerRef = useRef<number | null>(null);
  const recordingCourseRef = useRef<CourseOption | null>(null);

  const visibleSegments = useMemo(() => getDisplaySegments(transcriptState, 3), [transcriptState]);
  const latestSegment = visibleSegments.at(-1);
  const selectedCourse = useMemo(
    () => courses.find((course) => course.id === selectedCourseId) ?? null,
    [courses, selectedCourseId]
  );
  const canStart = (status === "idle" || status === "error") && Boolean(selectedCourse);
  const isLive = status === "recording" || status === "paused" || status === "connecting" || status === "closing";

  useEffect(() => {
    let active = true;

    loadSettings()
      .then((loaded) => {
        if (active) {
          setSettings(loaded);
        }
      })
      .catch(() => setErrorMessage("读取本机设置失败。"));

    fetchCourses()
      .then((remoteCourses) => {
        if (active) {
          setCourses(remoteCourses);
        }
      })
      .catch(() => {
        if (active) {
          setCourses(COURSES);
        }
      });

    refreshSessions().catch(() => {
      if (active) {
        setErrorMessage("读取服务器记录失败。");
      }
    });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    transcriptRef.current = transcriptState;
  }, [transcriptState]);

  useEffect(() => {
    if (!startedAt || status === "idle" || status === "error") {
      return;
    }

    const interval = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt.getTime());
    }, 500);

    return () => window.clearInterval(interval);
  }, [startedAt, status]);

  useEffect(() => {
    return () => {
      clientRef.current?.stop();
      if (commitTimerRef.current) {
        window.clearTimeout(commitTimerRef.current);
      }
    };
  }, []);

  async function refreshSessions() {
    setSessions(await listRemoteSessions());
  }

  async function persistSettings(nextSettings: AppSettings) {
    setSettings(nextSettings);
    await saveSettings(nextSettings);
  }

  async function startClass() {
    if (!selectedCourse) {
      setErrorMessage("请先选择课程，或选择日常 / 不选课程。");
      return;
    }

    const startTime = new Date();
    const initialState = createTranscriptState();
    recordingCourseRef.current = selectedCourse;
    setTranscriptState(initialState);
    transcriptRef.current = initialState;
    setStartedAt(startTime);
    setElapsedMs(0);
    setErrorMessage("");
    setViewMode("live");
    setStatus("connecting");

    const getClientSecret = async () => {
      const { clientSecret } = await createRealtimeClientSecret(settings.translationMode);
      return clientSecret;
    };
    const callbacks = {
      onOpen: () => setStatus("recording"),
      onDelta: handleRealtimeDelta,
      onSegment: handleRealtimeSegment,
      onError: (message: string) => {
        setErrorMessage(message);
        setStatus("error");
      },
      onClose: () => {
        setStatus((current) => (current === "closing" ? current : "idle"));
      }
    };
    const client =
      settings.translationMode === "realtime-translate"
        ? new RealtimeTranslationClient(getClientSecret, callbacks)
        : new RealtimeTranscriptionTranslationClient(getClientSecret, settings.textTranslationModel, callbacks);

    clientRef.current = client;
    try {
      await client.start();
    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "无法启动麦克风或 Realtime 连接。");
    }
  }

  function handleRealtimeDelta(delta: RealtimeTranscriptDelta) {
    setTranscriptState((current) => {
      const next = applyTranscriptDelta(current, delta);
      transcriptRef.current = next;
      return next;
    });
    scheduleCommit();
  }

  function handleRealtimeSegment(segment: RealtimeTranscriptSegment) {
    setTranscriptState((current) => {
      const next = appendTranscriptSegment(current, segment);
      transcriptRef.current = next;
      return next;
    });
  }

  function scheduleCommit() {
    if (commitTimerRef.current) {
      window.clearTimeout(commitTimerRef.current);
    }
    commitTimerRef.current = window.setTimeout(() => {
      setTranscriptState((current) => {
        const next = commitActiveSegment(current);
        transcriptRef.current = next;
        return next;
      });
    }, COMMIT_DELAY_MS);
  }

  function pauseClass() {
    clientRef.current?.pause();
    setStatus("paused");
  }

  function resumeClass() {
    clientRef.current?.resume();
    setStatus("recording");
  }

  async function endClass() {
    setStatus("closing");
    clientRef.current?.stop();
    clientRef.current = null;
    if (commitTimerRef.current) {
      window.clearTimeout(commitTimerRef.current);
    }

    const finalTranscript = commitActiveSegment(transcriptRef.current);
    setTranscriptState(finalTranscript);
    transcriptRef.current = finalTranscript;

    const endTime = new Date();
    const started = startedAt ?? endTime;
    const course = recordingCourseRef.current ?? selectedCourse ?? COURSES.find((item) => item.id === DAILY_COURSE_ID) ?? COURSES[0];
    const session: ClassSession = {
      id: createId("class"),
      title: `${course.id === DAILY_COURSE_ID ? "日常" : course.name} ${formatDateTime(started.toISOString())}`,
      courseId: course.id,
      courseCode: course.code,
      courseName: course.name,
      courseTerm: course.term,
      courseFolderName: course.folderName,
      startedAt: started.toISOString(),
      endedAt: endTime.toISOString(),
      durationMs: endTime.getTime() - started.getTime(),
      sourceLanguage: "ko",
      targetLanguage: "zh",
      models: {
        translation:
          settings.translationMode === "realtime-translate" ? "gpt-realtime-translate" : settings.textTranslationModel,
        transcription: "gpt-realtime-whisper",
        mode: settings.translationMode
      },
      segments: getAllSegments(finalTranscript).map((segment) => ({ ...segment, isFinal: true }))
    };

    try {
      const savedSession = await saveRemoteSession(session);
      await refreshSessions();
      setSelectedSession(savedSession);
      setErrorMessage("");
    } catch (error) {
      setSelectedSession(session);
      setErrorMessage(error instanceof Error ? `记录已生成，但保存到服务器失败：${error.message}` : "记录已生成，但保存到服务器失败。");
    } finally {
      recordingCourseRef.current = null;
      setViewMode("document");
      setStatus("idle");
      setStartedAt(null);
      setElapsedMs(0);
    }
  }

  async function openSession(session: ClassSessionSummary) {
    try {
      const fullSession = await getRemoteSession(session.id);
      setSelectedSession(fullSession);
      setViewMode("document");
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "读取记录失败。");
    }
  }

  async function exportSession(session: ClassSessionSummary) {
    try {
      downloadMarkdown(await getRemoteSession(session.id));
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "导出记录失败。");
    }
  }

  async function removeSession(session: ClassSessionSummary) {
    await deleteRemoteSession(session.id);
    if (selectedSession?.id === session.id) {
      setSelectedSession(null);
    }
    await refreshSessions();
  }

  async function updateSubtitleScale(value: number) {
    await persistSettings({ ...settings, subtitleScale: value });
  }

  async function toggleKoreanInline() {
    await persistSettings({ ...settings, showKoreanInline: !settings.showKoreanInline });
  }

  return (
    <div className="app-shell" style={{ "--subtitle-scale": settings.subtitleScale } as React.CSSProperties}>
      <header className="top-bar">
        <button className="brand-button" type="button" onClick={() => setViewMode("live")} aria-label="回到字幕">
          <span className="brand-mark">字</span>
          <span>课堂字幕</span>
        </button>

        <div className="status-strip" aria-live="polite">
          <span className={`status-dot status-${status}`} />
          <span>{statusLabel(status)}</span>
          <span className="timer">{formatDuration(elapsedMs)}</span>
        </div>

        <nav className="top-actions" aria-label="主要操作">
          <button className="icon-button" type="button" onClick={() => setSettingsOpen((open) => !open)} title="设置">
            <Settings size={20} />
          </button>
          <button className="icon-button secondary-nav" type="button" onClick={() => setViewMode("records")} title="记录">
            <Library size={20} />
          </button>
          {status === "paused" ? (
            <button className="primary-action" type="button" onClick={resumeClass} title="继续">
              <Play size={19} />
              <span className="control-label">继续</span>
            </button>
          ) : canStart || status === "idle" || status === "error" ? (
            <button className="primary-action" type="button" onClick={startClass} title="开始" disabled={!canStart}>
              <Mic size={19} />
              <span className="control-label">开始</span>
            </button>
          ) : (
            <button className="icon-button control" type="button" onClick={pauseClass} title="暂停" disabled={status !== "recording"}>
              <Pause size={20} />
            </button>
          )}
          <button className="icon-button danger" type="button" onClick={endClass} title="结束" disabled={!isLive}>
            <Square size={18} />
          </button>
        </nav>
      </header>

      {settingsOpen ? (
        <section className="settings-panel" aria-label="设置">
          <label className="range-field">
            字号
            <input
              value={settings.subtitleScale}
              min="0.8"
              max="1.5"
              step="0.05"
              onChange={(event) => updateSubtitleScale(Number(event.target.value))}
              type="range"
            />
          </label>
          <button className="ghost-button" type="button" onClick={toggleKoreanInline}>
            {settings.showKoreanInline ? <EyeOff size={17} /> : <Eye size={17} />}
            {settings.showKoreanInline ? "隐藏韩文" : "显示韩文"}
          </button>
          <button
            className="ghost-button settings-records-link"
            type="button"
            onClick={() => {
              setViewMode("records");
              setSettingsOpen(false);
            }}
          >
            <Library size={17} />
            记录
          </button>
          <button className="icon-button" type="button" onClick={() => setSettingsOpen(false)} title="关闭设置">
            <X size={18} />
          </button>
        </section>
      ) : null}

      {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}

      <main className="main-surface">
        {viewMode === "live" ? (
          <LiveSubtitleView
            status={status}
            segments={visibleSegments}
            showKorean={settings.showKoreanInline}
            courses={courses}
            selectedCourseId={selectedCourseId}
            canChooseCourse={!isLive}
            onSelectCourse={setSelectedCourseId}
          />
        ) : null}
        {viewMode === "records" ? <RecordsView sessions={sessions} onSelect={openSession} onDelete={removeSession} onExport={exportSession} /> : null}
        {viewMode === "document" ? (
          <DocumentView
            session={selectedSession}
            onBack={() => setViewMode("records")}
            onExport={(session) => downloadMarkdown(session)}
          />
        ) : null}
      </main>
    </div>
  );

  function statusLabel(current: ConnectionStatus) {
    switch (current) {
      case "connecting":
        return "连接中";
      case "recording":
        return "录音中";
      case "paused":
        return "已暂停";
      case "closing":
        return "保存中";
      case "error":
        return "错误";
      default:
        return latestSegment ? "已就绪" : "待开始";
    }
  }
}

function LiveSubtitleView({
  status,
  segments,
  showKorean,
  courses,
  selectedCourseId,
  canChooseCourse,
  onSelectCourse
}: {
  status: ConnectionStatus;
  segments: ReturnType<typeof getDisplaySegments>;
  showKorean: boolean;
  courses: CourseOption[];
  selectedCourseId: string;
  canChooseCourse: boolean;
  onSelectCourse: (courseId: string) => void;
}) {
  const hasText = segments.some((segment) => segment.translatedText.trim());

  if (!hasText) {
    return (
      <section className="subtitle-stage empty-stage">
        {canChooseCourse ? (
          <CoursePicker courses={courses} selectedCourseId={selectedCourseId} onSelectCourse={onSelectCourse} />
        ) : null}
        <p className="empty-subtitle">{emptyMessage(status, Boolean(selectedCourseId))}</p>
      </section>
    );
  }

  return (
    <section className="subtitle-stage" aria-live="polite">
      <div className="subtitle-stack">
        {segments.map((segment, index) => {
          const isLatest = index === segments.length - 1;
          return (
            <article className={`subtitle-line ${isLatest ? "latest" : "previous"}`} key={segment.id}>
              <p>{segment.translatedText.trim()}</p>
              {showKorean && segment.sourceText.trim() ? <small>{segment.sourceText.trim()}</small> : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function CoursePicker({
  courses,
  selectedCourseId,
  onSelectCourse
}: {
  courses: CourseOption[];
  selectedCourseId: string;
  onSelectCourse: (courseId: string) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(!selectedCourseId);
  const selectedCourse = courses.find((course) => course.id === selectedCourseId) ?? null;
  const gridId = "course-picker-grid";

  useEffect(() => {
    if (!selectedCourseId) {
      setIsExpanded(true);
    }
  }, [selectedCourseId]);

  function handleSelectCourse(courseId: string) {
    onSelectCourse(courseId);
    setIsExpanded(false);
  }

  if (!isExpanded && selectedCourse) {
    return (
      <div className="course-picker course-picker-compact" aria-label="选择课程">
        <button
          className="course-picker-toggle"
          type="button"
          aria-expanded={false}
          aria-controls={gridId}
          onClick={() => setIsExpanded(true)}
        >
          <FolderOpen size={18} aria-hidden="true" />
          <span className="course-picker-summary">
            <strong>{selectedCourse.name}</strong>
            <span>{courseMeta(selectedCourse)}</span>
          </span>
          <span className="course-picker-change">更换</span>
          <ChevronDown size={18} aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div className="course-picker" aria-label="选择课程">
      <button
        className="course-picker-title"
        type="button"
        aria-expanded={true}
        aria-controls={gridId}
        disabled={!selectedCourse}
        onClick={() => setIsExpanded(false)}
      >
        <FolderOpen size={18} aria-hidden="true" />
        <span>选择课程</span>
        {selectedCourse ? <ChevronUp size={16} aria-hidden="true" /> : null}
      </button>
      <div className="course-grid" id={gridId}>
        {courses.map((course) => (
          <button
            className={`course-button ${course.id === selectedCourseId ? "selected" : ""}`}
            type="button"
            key={course.id}
            aria-pressed={course.id === selectedCourseId}
            onClick={() => handleSelectCourse(course.id)}
          >
            <strong>{course.name}</strong>
            <span>{courseMeta(course)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function RecordsView({
  sessions,
  onSelect,
  onDelete,
  onExport
}: {
  sessions: ClassSessionSummary[];
  onSelect: (session: ClassSessionSummary) => void;
  onDelete: (session: ClassSessionSummary) => void;
  onExport: (session: ClassSessionSummary) => void;
}) {
  const groups = groupSessionsByCourse(sessions);

  return (
    <section className="records-view">
      <div className="section-heading">
        <BookOpen size={22} />
        <h1>记录</h1>
      </div>
      {sessions.length === 0 ? (
        <p className="muted">结束一节课后，完整中韩逐字稿会保存到服务器。</p>
      ) : (
        <div className="session-groups">
          {groups.map((group) => (
            <section className="session-course-group" key={group.courseFolderName}>
              <h2>{group.courseName}</h2>
              {group.courseTerm ? <p>{group.courseTerm}</p> : null}
              <ul className="session-list">
                {group.sessions.map((session) => (
                  <li className="session-row" key={session.id}>
                    <button type="button" onClick={() => onSelect(session)}>
                      <strong>{session.title}</strong>
                      <span>
                        {formatDateTime(session.startedAt)} · {formatDuration(session.durationMs)} · {session.segmentCount} 段
                      </span>
                    </button>
                    <div className="row-actions">
                      <button className="icon-button" type="button" onClick={() => onExport(session)} title="导出 Markdown">
                        <Download size={18} />
                      </button>
                      <button className="icon-button danger" type="button" onClick={() => onDelete(session)} title="删除">
                        <Trash2 size={18} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function DocumentView({
  session,
  onBack,
  onExport
}: {
  session: ClassSession | null;
  onBack: () => void;
  onExport: (session: ClassSession) => void;
}) {
  if (!session) {
    return (
      <section className="records-view">
        <p className="muted">没有选中的课堂记录。</p>
        <button className="ghost-button" type="button" onClick={onBack}>
          返回记录
        </button>
      </section>
    );
  }

  return (
    <section className="document-view">
      <div className="document-header">
        <button className="ghost-button" type="button" onClick={onBack}>
          返回
        </button>
        <div>
          <h1>{session.title}</h1>
          <p>
            {session.courseName}
            {session.courseTerm ? ` · ${session.courseTerm}` : ""} · {formatDateTime(session.startedAt)} ·{" "}
            {formatDuration(session.durationMs)}
          </p>
        </div>
        <button className="primary-action" type="button" onClick={() => onExport(session)}>
          <Download size={18} />
          <span className="control-label">Markdown</span>
        </button>
      </div>
      <div className="document-body">
        {session.segments.length === 0 ? (
          <p className="muted">这节课没有保存到字幕文本。</p>
        ) : (
          session.segments.map((segment) => (
            <article className="transcript-block" key={segment.id}>
              <time>{formatTimestamp(segment.startedAtMs)}</time>
              <p className="zh-text">{segment.translatedText.trim() || "无中文译文"}</p>
              <details>
                <summary>韩文原文</summary>
                <p lang="ko">{segment.sourceText.trim() || "无韩文原文"}</p>
              </details>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function emptyMessage(status: ConnectionStatus, hasCourse: boolean) {
  if (!hasCourse) {
    return "请选择课程或日常";
  }
  if (status === "connecting") {
    return "正在连接...";
  }
  if (status === "recording") {
    return "正在听...";
  }
  if (status === "paused") {
    return "已暂停";
  }
  return "准备开始";
}

function courseMeta(course: CourseOption) {
  return course.id === DAILY_COURSE_ID ? "日常" : `${course.code} · ${course.term}`;
}

function groupSessionsByCourse(sessions: ClassSessionSummary[]) {
  const groups = new Map<
    string,
    {
      courseFolderName: string;
      courseName: string;
      courseTerm: string;
      sessions: ClassSessionSummary[];
    }
  >();

  for (const session of sessions) {
    const key = session.courseFolderName;
    const group = groups.get(key);
    if (group) {
      group.sessions.push(session);
      continue;
    }

    groups.set(key, {
      courseFolderName: session.courseFolderName,
      courseName: session.courseName,
      courseTerm: session.courseTerm,
      sessions: [session]
    });
  }

  return Array.from(groups.values());
}
