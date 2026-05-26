import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Copy,
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
  AppConfig,
  AppSettings,
  ClassSession,
  ClassSessionSummary,
  ConnectionStatus,
  RealtimeClientDiagnostic,
  RealtimeTranscriptDelta,
  RealtimeTranscriptSegment,
  TextTranslationModel,
  TranscriptState
} from "./types";
import {
  createRealtimeClientSecret,
  deleteRemoteSession,
  fetchAppConfig,
  fetchCourses,
  getRemoteSession,
  listRemoteSessions,
  saveRemoteSession
} from "./lib/api";
import { createId } from "./lib/id";
import { buildAiCourseContext, buildAiSessionContext, downloadMarkdown } from "./lib/markdown";
import { ClassicRealtimeTranslationClient } from "./lib/classicRealtimeTranslation";
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
import {
  defaultSettings,
  listPendingSessions,
  loadSettings,
  queuePendingSession,
  removePendingSession,
  saveSettings,
  updatePendingSessionFailure
} from "./lib/storage";
import { formatDateTime, formatDuration, formatTimestamp } from "./lib/time";

type ViewMode = "live" | "records" | "document";
type LiveSubtitleClient = Pick<RealtimeTranslationClient, "start" | "pause" | "resume"> & {
  stop: () => void | Promise<void>;
};

const COMMIT_DELAY_MS = 1800;
const PENDING_SYNC_RETRY_MS = 30_000;
const EMPTY_APP_CONFIG: AppConfig = {
  realtimeTranslationModel: "",
  realtimeTranscriptionModel: "",
  defaultTextTranslationModel: "",
  textTranslationModels: []
};

interface DiagnosticState {
  microphoneLevel: number | null;
  dataChannelState: string;
  iceConnectionState: string;
  peerConnectionState: string;
  webSocketState: string;
  lastEventType: string;
  lastEventAt: number | null;
  lastTextAt: number | null;
  lastWarning: string;
}

interface SessionCourseGroup {
  courseFolderName: string;
  courseName: string;
  courseTerm: string;
  latestStartedAt: string;
  totalDurationMs: number;
  totalSegments: number;
  sessions: ClassSessionSummary[];
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [appConfig, setAppConfig] = useState<AppConfig>(EMPTY_APP_CONFIG);
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
  const [copyMessage, setCopyMessage] = useState("");
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [diagnostic, setDiagnostic] = useState<DiagnosticState>(createDiagnosticState);
  const [courseSelectionRequested, setCourseSelectionRequested] = useState(false);
  const [copyingTarget, setCopyingTarget] = useState<string | null>(null);

  const clientRef = useRef<LiveSubtitleClient | null>(null);
  const transcriptRef = useRef<TranscriptState>(transcriptState);
  const commitTimerRef = useRef<number | null>(null);
  const pendingSyncTimerRef = useRef<number | null>(null);
  const isSyncingPendingRef = useRef(false);
  const recordingCourseRef = useRef<CourseOption | null>(null);

  const visibleSegments = useMemo(() => getDisplaySegments(transcriptState, 3), [transcriptState]);
  const latestSegment = visibleSegments.at(-1);
  const selectedCourse = useMemo(
    () => courses.find((course) => course.id === selectedCourseId) ?? null,
    [courses, selectedCourseId]
  );
  const canStart = (status === "idle" || status === "error") && Boolean(selectedCourse);
  const isLive = status === "recording" || status === "paused" || status === "connecting" || status === "closing";
  const textTranslationModels = appConfig.textTranslationModels.length
    ? appConfig.textTranslationModels
    : settings.textTranslationModel
      ? [settings.textTranslationModel]
      : [];

  useEffect(() => {
    let active = true;

    Promise.all([loadSettings(), fetchAppConfig()])
      .then(async ([loadedSettings, remoteConfig]) => {
        if (active) {
          setAppConfig(remoteConfig);
          const normalizedSettings = normalizeSettingsForConfig(loadedSettings, remoteConfig);
          setSettings(normalizedSettings);
          if (normalizedSettings.textTranslationModel !== loadedSettings.textTranslationModel) {
            await saveSettings(normalizedSettings);
          }
        }
      })
      .catch(() => {
        if (active) {
          setErrorMessage("读取本机设置或服务器配置失败。");
        }
      });

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
    syncPendingSessions().catch(() => undefined);

    const syncOnOnline = () => {
      syncPendingSessions().catch(() => undefined);
    };
    window.addEventListener("online", syncOnOnline);

    return () => {
      active = false;
      window.removeEventListener("online", syncOnOnline);
      if (pendingSyncTimerRef.current) {
        window.clearTimeout(pendingSyncTimerRef.current);
      }
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
      void clientRef.current?.stop();
      if (commitTimerRef.current) {
        window.clearTimeout(commitTimerRef.current);
      }
    };
  }, []);

  async function refreshSessions() {
    setSessions(await listRemoteSessions());
  }

  async function syncPendingSessions() {
    if (isSyncingPendingRef.current) {
      return;
    }

    isSyncingPendingRef.current = true;
    try {
      const pendingRecords = await listPendingSessions();
      setPendingSyncCount(pendingRecords.length);
      let syncedCount = 0;

      for (const record of pendingRecords) {
        try {
          const savedSession = await saveRemoteSession(record.session);
          await removePendingSession(record.id);
          setSelectedSession((current) => (current?.id === record.id ? savedSession : current));
          syncedCount += 1;
        } catch (error) {
          await updatePendingSessionFailure(record.id, error instanceof Error ? error.message : "同步记录失败。");
          break;
        }
      }

      const remainingRecords = await listPendingSessions();
      setPendingSyncCount(remainingRecords.length);
      if (syncedCount > 0) {
        await refreshSessions().catch(() => {
          setErrorMessage("待同步记录已上传，但刷新服务器记录列表失败。");
        });
      }
      if (remainingRecords.length > 0) {
        schedulePendingSync();
      }
    } finally {
      isSyncingPendingRef.current = false;
    }
  }

  function schedulePendingSync() {
    if (pendingSyncTimerRef.current) {
      window.clearTimeout(pendingSyncTimerRef.current);
    }

    pendingSyncTimerRef.current = window.setTimeout(() => {
      syncPendingSessions().catch(() => undefined);
    }, PENDING_SYNC_RETRY_MS);
  }

  async function persistSettings(nextSettings: AppSettings) {
    setSettings(nextSettings);
    await saveSettings(nextSettings);
  }

  function selectCourse(courseId: string) {
    setSelectedCourseId(courseId);
    setCourseSelectionRequested(false);
    setCopyMessage("");
  }

  function requestCourseBeforeStart() {
    setViewMode("live");
    setCourseSelectionRequested(true);
    setCopyMessage("");
    setErrorMessage("");
  }

  function handleStartIntent() {
    if (!selectedCourse) {
      requestCourseBeforeStart();
      return;
    }

    void startClass();
  }

  async function startClass() {
    if (!selectedCourse) {
      requestCourseBeforeStart();
      return;
    }

    const startTime = new Date();
    const initialState = createTranscriptState();
    recordingCourseRef.current = selectedCourse;
    setTranscriptState(initialState);
    transcriptRef.current = initialState;
    setStartedAt(startTime);
    setElapsedMs(0);
    setDiagnostic(createDiagnosticState());
    setErrorMessage("");
    setCopyMessage("");
    setCourseSelectionRequested(false);
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
      onDiagnostic: handleRealtimeDiagnostic,
      onError: (message: string) => {
        setErrorMessage(message);
        setStatus("error");
      },
      onClose: () => {
        setStatus((current) => (current === "closing" ? current : "idle"));
      }
    };
    const client =
      settings.translationMode === "classic-websocket-translate"
        ? new ClassicRealtimeTranslationClient(
            getClientSecret,
            appConfig.realtimeTranslationModel || "gpt-realtime-translate",
            appConfig.realtimeTranscriptionModel || "gpt-realtime-whisper",
            callbacks
          )
        : settings.translationMode === "realtime-translate"
        ? new RealtimeTranslationClient(getClientSecret, callbacks)
        : new RealtimeTranscriptionTranslationClient(
            getClientSecret,
            settings.textTranslationModel || appConfig.defaultTextTranslationModel,
            callbacks
          );

    clientRef.current = client;
    try {
      await client.start();
    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "无法启动麦克风或 Realtime 连接。");
    }
  }

  function handleRealtimeDelta(delta: RealtimeTranscriptDelta) {
    markTextReceived();
    setTranscriptState((current) => {
      const next = applyTranscriptDelta(current, delta);
      transcriptRef.current = next;
      return next;
    });
    scheduleCommit();
  }

  function handleRealtimeSegment(segment: RealtimeTranscriptSegment) {
    markTextReceived();
    setTranscriptState((current) => {
      const next = appendTranscriptSegment(current, segment);
      transcriptRef.current = next;
      return next;
    });
  }

  function handleRealtimeDiagnostic(event: RealtimeClientDiagnostic) {
    setDiagnostic((current) => {
      if (event.kind === "microphone") {
        return {
          ...current,
          microphoneLevel: event.level ?? current.microphoneLevel
        };
      }

      if (event.kind === "connection" && event.connection) {
        return {
          ...current,
          dataChannelState:
            event.connection === "dataChannel" ? event.state ?? current.dataChannelState : current.dataChannelState,
          iceConnectionState: event.connection === "ice" ? event.state ?? current.iceConnectionState : current.iceConnectionState,
          peerConnectionState:
            event.connection === "peer" ? event.state ?? current.peerConnectionState : current.peerConnectionState,
          webSocketState: event.connection === "webSocket" ? event.state ?? current.webSocketState : current.webSocketState
        };
      }

      if (event.kind === "event") {
        return {
          ...current,
          lastEventType: event.eventType ?? current.lastEventType,
          lastEventAt: event.at
        };
      }

      if (event.kind === "warning") {
        return {
          ...current,
          lastWarning: event.message ?? current.lastWarning
        };
      }

      return current;
    });
  }

  function markTextReceived() {
    setDiagnostic((current) => ({
      ...current,
      lastTextAt: Date.now()
    }));
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
    const client = clientRef.current;
    clientRef.current = null;
    try {
      await client?.stop();
    } catch (error) {
      setErrorMessage(error instanceof Error ? `结束课堂时收尾失败：${error.message}` : "结束课堂时收尾失败。");
    }
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
          isRealtimeTranslationMode(settings.translationMode)
            ? appConfig.realtimeTranslationModel || "server-configured-realtime-translation"
            : settings.textTranslationModel || appConfig.defaultTextTranslationModel || "server-configured-text-translation",
        transcription: appConfig.realtimeTranscriptionModel || "server-configured-realtime-transcription",
        mode: settings.translationMode
      },
      segments: getAllSegments(finalTranscript).map((segment) => ({ ...segment, isFinal: true }))
    };

    try {
      const savedSession = await saveRemoteSession(session);
      await removePendingSession(session.id);
      setSelectedSession(savedSession);
      setErrorMessage("");
      setPendingSyncCount((await listPendingSessions()).length);
      refreshSessions().catch(() => {
        setErrorMessage("记录已保存，但刷新服务器记录列表失败。");
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存到服务器失败。";
      try {
        await queuePendingSession(session, message);
        setPendingSyncCount((current) => Math.max(1, current));
        schedulePendingSync();
      } catch {
        setErrorMessage(`记录已生成，但保存服务器和本机待同步队列都失败：${message}`);
      }
      setSelectedSession(session);
      setErrorMessage((current) => current || `记录已生成，并已加入本机待同步队列：${message}`);
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

  async function copySessionForAi(session: ClassSessionSummary | ClassSession) {
    const target = `session:${session.id}`;
    setCopyingTarget(target);
    try {
      const fullSession = "segments" in session ? session : await getRemoteSession(session.id);
      await writeClipboard(buildAiSessionContext(fullSession));
      setCopyMessage(`已复制给 AI：${fullSession.title}`);
      setErrorMessage("");
    } catch (error) {
      setCopyMessage("");
      setErrorMessage(error instanceof Error ? error.message : "复制记录失败。");
    } finally {
      setCopyingTarget((current) => (current === target ? null : current));
    }
  }

  async function copyCourseForAi(group: SessionCourseGroup) {
    const target = `course:${group.courseFolderName}`;
    setCopyingTarget(target);
    try {
      const orderedSessions = [...group.sessions].sort(compareSessionStartAsc);
      const fullSessions = await Promise.all(orderedSessions.map((session) => getRemoteSession(session.id)));
      await writeClipboard(buildAiCourseContext(fullSessions));
      setCopyMessage(`已复制给 AI：${group.courseName} 共 ${fullSessions.length} 次课`);
      setErrorMessage("");
    } catch (error) {
      setCopyMessage("");
      setErrorMessage(error instanceof Error ? error.message : "复制课程记录失败。");
    } finally {
      setCopyingTarget((current) => (current === target ? null : current));
    }
  }

  async function removeSession(session: ClassSessionSummary) {
    if (!window.confirm(`删除记录「${session.title}」？`)) {
      return;
    }

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

  async function updateTranslationMode(value: AppSettings["translationMode"]) {
    await persistSettings({ ...settings, translationMode: value });
  }

  async function updateTextTranslationModel(value: TextTranslationModel) {
    await persistSettings({ ...settings, textTranslationModel: value });
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
          <button className="icon-button secondary-nav" type="button" onClick={() => setViewMode("records")} title="资料库">
            <Library size={20} />
          </button>
          {status === "paused" ? (
            <button className="primary-action" type="button" onClick={resumeClass} title="继续">
              <Play size={19} />
              <span className="control-label">继续</span>
            </button>
          ) : canStart || status === "idle" || status === "error" ? (
            <button
              className={`primary-action ${selectedCourse ? "" : "needs-course"}`}
              type="button"
              onClick={handleStartIntent}
              title={selectedCourse ? "开始录音" : "先选择课程"}
            >
              <Mic size={19} />
              <span className="control-label">{selectedCourse ? "开始" : "选课"}</span>
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
          <label className="select-field">
            模式
            <select
              value={settings.translationMode}
              disabled={isLive}
              onChange={(event) => updateTranslationMode(event.target.value as AppSettings["translationMode"])}
            >
              <option value="classic-websocket-translate">经典低延迟</option>
              <option value="realtime-translate">官方 WebRTC</option>
              <option value="transcribe-then-translate">先转录再翻译</option>
            </select>
          </label>
          {settings.translationMode === "transcribe-then-translate" ? (
            <label className="select-field">
              模型
              <select
                value={settings.textTranslationModel}
                disabled={isLive}
                onChange={(event) => updateTextTranslationModel(event.target.value as TextTranslationModel)}
              >
                {textTranslationModels.length === 0 ? <option value="">服务器默认</option> : null}
                {textTranslationModels.map((model) => (
                  <option value={model} key={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
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
            资料库
          </button>
          <button className="icon-button" type="button" onClick={() => setSettingsOpen(false)} title="关闭设置">
            <X size={18} />
          </button>
        </section>
      ) : null}

      {isLive ? <DiagnosticStrip diagnostic={diagnostic} mode={settings.translationMode} now={Date.now()} /> : null}

      {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}
      {copyMessage ? <p className="copy-banner">{copyMessage}</p> : null}
      {pendingSyncCount > 0 ? <p className="sync-banner">{pendingSyncCount} 条记录待同步，会自动重试。</p> : null}

      <main className="main-surface">
        {viewMode === "live" ? (
          <LiveSubtitleView
            status={status}
            segments={visibleSegments}
            showKorean={settings.showKoreanInline}
            courses={courses}
            selectedCourseId={selectedCourseId}
            canChooseCourse={!isLive}
            selectedCourse={selectedCourse}
            needsCourseAttention={courseSelectionRequested}
            translationMode={settings.translationMode}
            onSelectCourse={selectCourse}
            onStart={handleStartIntent}
          />
        ) : null}
        {viewMode === "records" ? (
          <RecordsView
            sessions={sessions}
            copyingTarget={copyingTarget}
            onSelect={openSession}
            onDelete={removeSession}
            onExport={exportSession}
            onCopySession={copySessionForAi}
            onCopyCourse={copyCourseForAi}
          />
        ) : null}
        {viewMode === "document" ? (
          <DocumentView
            session={selectedSession}
            onBack={() => setViewMode("records")}
            onExport={(session) => downloadMarkdown(session)}
            onCopy={copySessionForAi}
            isCopying={selectedSession ? copyingTarget === `session:${selectedSession.id}` : false}
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

function DiagnosticStrip({
  diagnostic,
  mode,
  now
}: {
  diagnostic: DiagnosticState;
  mode: AppSettings["translationMode"];
  now: number;
}) {
  return (
    <section className="diagnostic-strip" aria-label="连接诊断">
      <span>{modeLabel(mode)}</span>
      <span>{microphoneLabel(diagnostic.microphoneLevel)}</span>
      {mode === "classic-websocket-translate" ? (
        <span>WebSocket {diagnostic.webSocketState}</span>
      ) : (
        <>
          <span>Data {diagnostic.dataChannelState}</span>
          <span>WebRTC {connectionLabel(diagnostic.peerConnectionState, diagnostic.iceConnectionState)}</span>
        </>
      )}
      <span>{eventLabel(diagnostic.lastEventType, diagnostic.lastEventAt, now)}</span>
      <span>{textLabel(diagnostic.lastTextAt, now)}</span>
      {diagnostic.lastWarning ? <span>{diagnostic.lastWarning}</span> : null}
    </section>
  );
}

function createDiagnosticState(): DiagnosticState {
  return {
    microphoneLevel: null,
    dataChannelState: "new",
    iceConnectionState: "new",
    peerConnectionState: "new",
    webSocketState: "new",
    lastEventType: "",
    lastEventAt: null,
    lastTextAt: null,
    lastWarning: ""
  };
}

function microphoneLabel(level: number | null): string {
  if (level === null) {
    return "麦克风 --";
  }

  const percent = Math.min(100, Math.round(level * 1000));
  if (level >= 0.008) {
    return `麦克风有声 ${percent}%`;
  }
  if (level >= 0.002) {
    return `麦克风偏低 ${percent}%`;
  }
  return `麦克风无声 ${percent}%`;
}

function connectionLabel(peerState: string, iceState: string): string {
  if (peerState === "connected" || iceState === "connected" || iceState === "completed") {
    return "已连";
  }
  if (peerState === "failed" || iceState === "failed" || iceState === "disconnected") {
    return `${peerState}/${iceState}`;
  }
  return `${peerState}/${iceState}`;
}

function eventLabel(eventType: string, eventAt: number | null, now: number): string {
  if (!eventAt) {
    return "事件 --";
  }

  return `事件 ${shortEventType(eventType)} ${formatAgo(eventAt, now)}`;
}

function textLabel(textAt: number | null, now: number): string {
  if (!textAt) {
    return "字幕 --";
  }

  return `字幕 ${formatAgo(textAt, now)}`;
}

function formatAgo(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 1) {
    return "刚刚";
  }
  return `${seconds}s`;
}

function shortEventType(eventType: string): string {
  return eventType.replace(/^conversation\.item\./, "").replace(/^session\./, "");
}

function modeLabel(mode: AppSettings["translationMode"]): string {
  switch (mode) {
    case "classic-websocket-translate":
      return "经典低延迟";
    case "realtime-translate":
      return "官方 WebRTC";
    default:
      return "先转录再翻译";
  }
}

function LiveSubtitleView({
  status,
  segments,
  showKorean,
  courses,
  selectedCourseId,
  canChooseCourse,
  selectedCourse,
  needsCourseAttention,
  translationMode,
  onSelectCourse,
  onStart
}: {
  status: ConnectionStatus;
  segments: ReturnType<typeof getDisplaySegments>;
  showKorean: boolean;
  courses: CourseOption[];
  selectedCourseId: string;
  canChooseCourse: boolean;
  selectedCourse: CourseOption | null;
  needsCourseAttention: boolean;
  translationMode: AppSettings["translationMode"];
  onSelectCourse: (courseId: string) => void;
  onStart: () => void;
}) {
  const hasText = segments.some((segment) => segment.translatedText.trim());

  if (!hasText) {
    if (!canChooseCourse) {
      return (
        <section className="subtitle-stage empty-stage">
          <p className="empty-subtitle">{emptyMessage(status, Boolean(selectedCourseId))}</p>
        </section>
      );
    }

    return (
      <ClassStartView
        courses={courses}
        selectedCourse={selectedCourse}
        selectedCourseId={selectedCourseId}
        needsCourseAttention={needsCourseAttention}
        translationMode={translationMode}
        onSelectCourse={onSelectCourse}
        onStart={onStart}
      />
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

function ClassStartView({
  courses,
  selectedCourse,
  selectedCourseId,
  needsCourseAttention,
  translationMode,
  onSelectCourse,
  onStart
}: {
  courses: CourseOption[];
  selectedCourse: CourseOption | null;
  selectedCourseId: string;
  needsCourseAttention: boolean;
  translationMode: AppSettings["translationMode"];
  onSelectCourse: (courseId: string) => void;
  onStart: () => void;
}) {
  const hasCourse = Boolean(selectedCourse);

  return (
    <section className="subtitle-stage ready-stage" aria-label="上课准备">
      <div className="start-workflow">
        <div className="prep-header">
          <p className="eyebrow">上课准备</p>
          <h1>{hasCourse ? "可以开始录音" : "先选择本节课"}</h1>
          <p>{hasCourse ? "课程已确认，点击开始后允许麦克风权限。" : "选择课程后，这节课会自动归档到对应资料库。"}</p>
        </div>

        <ol className="prep-steps" aria-label="录音流程">
          <li className={hasCourse ? "done" : "active"}>
            <span>1</span>
            <strong>选择课程</strong>
          </li>
          <li className={hasCourse ? "active" : ""}>
            <span>2</span>
            <strong>确认麦克风</strong>
          </li>
          <li>
            <span>3</span>
            <strong>开始录音</strong>
          </li>
        </ol>

        <CoursePicker
          courses={courses}
          selectedCourseId={selectedCourseId}
          highlight={needsCourseAttention && !hasCourse}
          onSelectCourse={onSelectCourse}
        />

        <div className="start-panel">
          <div className="prep-summary">
            <span>当前课程</span>
            <strong>{selectedCourse ? selectedCourse.name : "未选择"}</strong>
            <small>{selectedCourse ? courseMeta(selectedCourse) : "请选择课程，或选择日常 / 不选课程"}</small>
          </div>
          <div className="prep-summary">
            <span>翻译模式</span>
            <strong>{modeLabel(translationMode)}</strong>
            <small>开始后浏览器会请求麦克风权限</small>
          </div>
          <button className={`start-recording-button ${hasCourse ? "" : "needs-course"}`} type="button" onClick={onStart}>
            <Mic size={23} />
            <span>{hasCourse ? "开始录音" : "先选择课程"}</span>
          </button>
        </div>

        {needsCourseAttention && !hasCourse ? (
          <p className="start-hint" role="status">
            请选择本节课对应课程或日常，然后再开始录音。
          </p>
        ) : null}
      </div>
    </section>
  );
}

function CoursePicker({
  courses,
  selectedCourseId,
  highlight = false,
  onSelectCourse
}: {
  courses: CourseOption[];
  selectedCourseId: string;
  highlight?: boolean;
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

  useEffect(() => {
    if (highlight) {
      setIsExpanded(true);
    }
  }, [highlight]);

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
    <div className={`course-picker ${highlight ? "attention" : ""}`} aria-label="选择课程">
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
  copyingTarget,
  onSelect,
  onDelete,
  onExport,
  onCopySession,
  onCopyCourse
}: {
  sessions: ClassSessionSummary[];
  copyingTarget: string | null;
  onSelect: (session: ClassSessionSummary) => void;
  onDelete: (session: ClassSessionSummary) => void;
  onExport: (session: ClassSessionSummary) => void;
  onCopySession: (session: ClassSessionSummary) => void;
  onCopyCourse: (group: SessionCourseGroup) => void;
}) {
  const groups = groupSessionsByCourse(sessions);

  return (
    <section className="records-view library-view">
      <div className="section-heading">
        <Library size={22} />
        <div>
          <h1>资料库</h1>
          <p>按课程整理课后中韩转录，可直接复制给 AI 作为上下文。</p>
        </div>
      </div>
      {sessions.length === 0 ? (
        <p className="muted">结束一节课后，完整中韩逐字稿会保存到服务器。</p>
      ) : (
        <div className="session-groups">
          {groups.map((group) => (
            <section className="session-course-group library-course-group" key={group.courseFolderName}>
              <div className="library-course-header">
                <div>
                  <h2>{group.courseName}</h2>
                  <p>
                    {group.courseTerm ? `${group.courseTerm} · ` : ""}
                    {group.sessions.length} 次课 · {formatDuration(group.totalDurationMs)} · {group.totalSegments} 段 · 最近{" "}
                    {formatDateTime(group.latestStartedAt)}
                  </p>
                </div>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => onCopyCourse(group)}
                  title="复制整门课给 AI"
                  disabled={copyingTarget === `course:${group.courseFolderName}`}
                >
                  <Copy size={17} />
                  {copyingTarget === `course:${group.courseFolderName}` ? "复制中" : "复制整门课"}
                </button>
              </div>
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
                      <button
                        className="row-action-button"
                        type="button"
                        onClick={() => onCopySession(session)}
                        title="复制本节课给 AI"
                        disabled={copyingTarget === `session:${session.id}`}
                      >
                        <Copy size={17} />
                        <span>{copyingTarget === `session:${session.id}` ? "复制中" : "复制"}</span>
                      </button>
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
  onExport,
  onCopy,
  isCopying
}: {
  session: ClassSession | null;
  onBack: () => void;
  onExport: (session: ClassSession) => void;
  onCopy: (session: ClassSession) => void;
  isCopying: boolean;
}) {
  if (!session) {
    return (
      <section className="records-view">
        <p className="muted">没有选中的课堂记录。</p>
        <button className="ghost-button" type="button" onClick={onBack}>
          返回资料库
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
        <div className="document-actions">
          <button className="primary-action" type="button" onClick={() => onCopy(session)} disabled={isCopying}>
            <Copy size={18} />
            <span className="control-label">{isCopying ? "复制中" : "复制给 AI"}</span>
          </button>
          <button className="ghost-button" type="button" onClick={() => onExport(session)}>
            <Download size={18} />
            <span className="control-label">Markdown</span>
          </button>
        </div>
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

function groupSessionsByCourse(sessions: ClassSessionSummary[]): SessionCourseGroup[] {
  const groups = new Map<string, SessionCourseGroup>();

  for (const session of sessions) {
    const key = session.courseFolderName;
    const group = groups.get(key);
    if (group) {
      group.sessions.push(session);
      group.latestStartedAt =
        compareSessionStartDesc(session, { startedAt: group.latestStartedAt }) < 0 ? session.startedAt : group.latestStartedAt;
      group.totalDurationMs += session.durationMs;
      group.totalSegments += session.segmentCount;
      continue;
    }

    groups.set(key, {
      courseFolderName: session.courseFolderName,
      courseName: session.courseName,
      courseTerm: session.courseTerm,
      latestStartedAt: session.startedAt,
      totalDurationMs: session.durationMs,
      totalSegments: session.segmentCount,
      sessions: [session]
    });
  }

  return Array.from(groups.values()).map((group) => ({
    ...group,
    sessions: [...group.sessions].sort(compareSessionStartDesc)
  }));
}

function compareSessionStartAsc(left: Pick<ClassSessionSummary, "startedAt">, right: Pick<ClassSessionSummary, "startedAt">) {
  return Date.parse(left.startedAt) - Date.parse(right.startedAt);
}

function compareSessionStartDesc(left: Pick<ClassSessionSummary, "startedAt">, right: Pick<ClassSessionSummary, "startedAt">) {
  return Date.parse(right.startedAt) - Date.parse(left.startedAt);
}

async function writeClipboard(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error("当前浏览器不支持剪贴板复制。");
  }

  await navigator.clipboard.writeText(text);
}

function isRealtimeTranslationMode(mode: AppSettings["translationMode"]): boolean {
  return mode === "classic-websocket-translate" || mode === "realtime-translate";
}

function normalizeSettingsForConfig(settings: AppSettings, config: AppConfig): AppSettings {
  if (config.textTranslationModels.length === 0) {
    return settings;
  }

  if (settings.textTranslationModel && config.textTranslationModels.includes(settings.textTranslationModel)) {
    return settings;
  }

  return {
    ...settings,
    textTranslationModel: config.defaultTextTranslationModel
  };
}
