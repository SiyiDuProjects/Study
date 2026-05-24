import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Library,
  Mic,
  Pause,
  Play,
  Settings,
  Square,
  Trash2,
  X
} from "lucide-react";
import type { AppSettings, ClassSession, ConnectionStatus, RealtimeTranscriptDelta, TranscriptState } from "./types";
import { createId } from "./lib/id";
import { downloadMarkdown } from "./lib/markdown";
import { RealtimeTranslationClient } from "./lib/realtimeTranslation";
import {
  applyTranscriptDelta,
  commitActiveSegment,
  createTranscriptState,
  getAllSegments,
  getDisplaySegments
} from "./lib/transcriptReducer";
import { deleteSession, defaultSettings, listSessions, loadSettings, saveSession, saveSettings } from "./lib/storage";
import { formatDateTime, formatDuration, formatTimestamp } from "./lib/time";

type ViewMode = "live" | "records" | "document";

const COMMIT_DELAY_MS = 1800;

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [viewMode, setViewMode] = useState<ViewMode>("live");
  const [sessions, setSessions] = useState<ClassSession[]>([]);
  const [selectedSession, setSelectedSession] = useState<ClassSession | null>(null);
  const [transcriptState, setTranscriptState] = useState<TranscriptState>(createTranscriptState);
  const [startedAt, setStartedAt] = useState<Date | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const clientRef = useRef<RealtimeTranslationClient | null>(null);
  const transcriptRef = useRef<TranscriptState>(transcriptState);
  const commitTimerRef = useRef<number | null>(null);

  const visibleSegments = useMemo(() => getDisplaySegments(transcriptState, 3), [transcriptState]);
  const latestSegment = visibleSegments.at(-1);
  const canStart = status === "idle" || status === "error";
  const isLive = status === "recording" || status === "paused" || status === "connecting" || status === "closing";

  useEffect(() => {
    loadSettings()
      .then((loaded) => {
        setSettings(loaded);
        setApiKeyInput(loaded.apiKey ?? "");
      })
      .catch(() => setErrorMessage("读取本机设置失败。"));
    refreshSessions();
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
    setSessions(await listSessions());
  }

  async function persistSettings(nextSettings: AppSettings) {
    setSettings(nextSettings);
    await saveSettings(nextSettings);
  }

  async function startClass() {
    const apiKey = apiKeyInput.trim();
    if (!apiKey) {
      setErrorMessage("需要先输入 OpenAI API key。");
      return;
    }

    const nextSettings: AppSettings = {
      ...settings,
      apiKey: settings.rememberApiKey ? apiKey : undefined
    };
    await persistSettings(nextSettings);

    const startTime = new Date();
    const initialState = createTranscriptState();
    setTranscriptState(initialState);
    transcriptRef.current = initialState;
    setStartedAt(startTime);
    setElapsedMs(0);
    setErrorMessage("");
    setViewMode("live");
    setStatus("connecting");

    const client = new RealtimeTranslationClient(apiKey, {
      onOpen: () => setStatus("recording"),
      onDelta: handleRealtimeDelta,
      onError: (message) => {
        setErrorMessage(message);
        setStatus("error");
      },
      onClose: () => {
        if (status !== "closing") {
          setStatus((current) => (current === "closing" ? current : "idle"));
        }
      }
    });

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
    const session: ClassSession = {
      id: createId("class"),
      title: `韩语课堂 ${formatDateTime(started.toISOString())}`,
      startedAt: started.toISOString(),
      endedAt: endTime.toISOString(),
      durationMs: endTime.getTime() - started.getTime(),
      sourceLanguage: "ko",
      targetLanguage: "zh",
      models: {
        translation: "gpt-realtime-translate",
        transcription: "gpt-realtime-whisper"
      },
      segments: getAllSegments(finalTranscript).map((segment) => ({ ...segment, isFinal: true }))
    };

    await saveSession(session);
    await refreshSessions();
    setSelectedSession(session);
    setViewMode("document");
    setStatus("idle");
    setStartedAt(null);
    setElapsedMs(0);
  }

  async function removeSession(session: ClassSession) {
    await deleteSession(session.id);
    if (selectedSession?.id === session.id) {
      setSelectedSession(null);
    }
    await refreshSessions();
  }

  async function updateRememberApiKey(rememberApiKey: boolean) {
    const nextSettings: AppSettings = {
      ...settings,
      rememberApiKey,
      apiKey: rememberApiKey ? apiKeyInput.trim() : undefined
    };
    await persistSettings(nextSettings);
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
          {canStart ? (
            <button className="primary-action" type="button" onClick={startClass} title="开始">
              <Mic size={19} />
              <span className="control-label">开始</span>
            </button>
          ) : status === "paused" ? (
            <button className="primary-action" type="button" onClick={resumeClass} title="继续">
              <Play size={19} />
              <span className="control-label">继续</span>
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
          <label className="key-field">
            <KeyRound size={18} />
            <input
              value={apiKeyInput}
              onChange={(event) => setApiKeyInput(event.target.value)}
              type="password"
              placeholder="OpenAI API key"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="checkbox-field">
            <input
              checked={settings.rememberApiKey}
              onChange={(event) => updateRememberApiKey(event.target.checked)}
              type="checkbox"
            />
            记住本设备
          </label>
          <label className="range-field">
            字号
            <input
              value={settings.subtitleScale}
              min="0.8"
              max="1.35"
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
            hasApiKey={Boolean(apiKeyInput.trim())}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : null}
        {viewMode === "records" ? (
          <RecordsView
            sessions={sessions}
            onSelect={(session) => {
              setSelectedSession(session);
              setViewMode("document");
            }}
            onDelete={removeSession}
            onExport={downloadMarkdown}
          />
        ) : null}
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
  hasApiKey,
  onOpenSettings
}: {
  status: ConnectionStatus;
  segments: ReturnType<typeof getDisplaySegments>;
  showKorean: boolean;
  hasApiKey: boolean;
  onOpenSettings: () => void;
}) {
  const hasText = segments.some((segment) => segment.translatedText.trim());

  if (!hasText) {
    return (
      <section className="subtitle-stage empty-stage">
        <p className="empty-subtitle">{emptyMessage(status, hasApiKey)}</p>
        {!hasApiKey ? (
          <button className="ghost-button" type="button" onClick={onOpenSettings}>
            <KeyRound size={18} />
            输入 API key
          </button>
        ) : null}
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

function RecordsView({
  sessions,
  onSelect,
  onDelete,
  onExport
}: {
  sessions: ClassSession[];
  onSelect: (session: ClassSession) => void;
  onDelete: (session: ClassSession) => void;
  onExport: (session: ClassSession) => void;
}) {
  return (
    <section className="records-view">
      <div className="section-heading">
        <BookOpen size={22} />
        <h1>记录</h1>
      </div>
      {sessions.length === 0 ? (
        <p className="muted">结束一节课后，完整中韩逐字稿会保存在这里。</p>
      ) : (
        <ul className="session-list">
          {sessions.map((session) => (
            <li className="session-row" key={session.id}>
              <button type="button" onClick={() => onSelect(session)}>
                <strong>{session.title}</strong>
                <span>
                  {formatDuration(session.durationMs)} · {session.segments.length} 段
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
            {formatDateTime(session.startedAt)} · {formatDuration(session.durationMs)}
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

function emptyMessage(status: ConnectionStatus, hasApiKey: boolean) {
  if (!hasApiKey) {
    return "先输入 API key";
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
