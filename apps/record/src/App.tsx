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
  RefreshCw,
  Settings,
  Square,
  Trash2,
  X
} from "lucide-react";
import { DAILY_COURSE, DAILY_COURSE_ID, type CourseOption } from "../shared/courses";
import type {
  AppSettings,
  ClassSession,
  ClassSessionSummary,
  CompleteLectureSessionRequest,
  ConnectionStatus,
  LiveSubtitleClient,
  RealtimeTranscriptDelta,
  RealtimeTranscriptSegment,
  TranscriptSegment,
  TranscriptState
} from "./types";
import {
  ApiRequestError,
  archiveRemoteSession,
  checkpointRemoteSession,
  completeRemoteSession,
  createRealtimeClientSecret,
  createRemoteSession,
  failRemoteSession,
  fetchCourses,
  getRemoteSession,
  listRemoteSessions,
  resumeRemoteSession
} from "./lib/api";
import { downloadMarkdown } from "./lib/markdown";
import { CoalescingTaskQueue } from "./lib/coalescingTaskQueue";
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
import { connectionElapsedBase, nextCommitSequence } from "./lib/sessionTimeline";
import { formatDateTime, formatDuration, formatTimestamp } from "./lib/time";

type ViewMode = "live" | "records" | "document";
type PersistenceMode = "checkpoint" | "failed";

const COMMIT_DELAY_MS = 1800;
const CHECKPOINT_INTERVAL_MS = 4_000;
const CHECKPOINT_BATCH_SIZE = 500;
const CHECKPOINT_DRAIN_TIMEOUT_MS = 9_000;
const INCOMPLETE_FINALIZATION_WARNING = "Realtime 结束时未能确认最后一段字幕，记录可能缺少最后一段。";

class CheckpointDrainTimeoutError extends Error {
  constructor() {
    super("自动保存请求未能在限定时间内结束");
  }
}

function isWriterLeaseConflictError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.code === "writer_lease_conflict";
}

function isUncertainWriteError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof ApiRequestError && error.code === "client_timeout");
}

async function waitForPromise(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeoutId: number | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timeoutId = window.setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [courses, setCourses] = useState<CourseOption[]>([DAILY_COURSE]);
  const [coursesLoading, setCoursesLoading] = useState(true);
  const [courseNotice, setCourseNotice] = useState("");
  const [selectedCourseId, setSelectedCourseId] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [viewMode, setViewMode] = useState<ViewMode>("live");
  const [sessions, setSessions] = useState<ClassSessionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<ClassSession | null>(null);
  const [transcriptState, setTranscriptState] = useState<TranscriptState>(createTranscriptState);
  const [startedAt, setStartedAt] = useState<Date | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const [finalizationWarning, setFinalizationWarning] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const clientRef = useRef<LiveSubtitleClient | null>(null);
  const transcriptRef = useRef<TranscriptState>(transcriptState);
  const activeSessionIdRef = useRef<string | null>(null);
  const startedAtRef = useRef<Date | null>(null);
  const recordingCourseRef = useRef<CourseOption | null>(null);
  const commitTimerRef = useRef<number | null>(null);
  const checkpointQueueRef = useRef(new CoalescingTaskQueue());
  const savedSegmentSignaturesRef = useRef(new Map<string, string>());
  const finalizationWarningRef = useRef<string | null>(null);
  const writerLeaseTokenRef = useRef<string | null>(null);
  const sessionRevisionRef = useRef<number | null>(null);
  const statusRef = useRef<ConnectionStatus>(status);
  const connectionGenerationRef = useRef(0);
  const startPreparationRef = useRef<Promise<void> | null>(null);

  const visibleSegments = useMemo(() => getDisplaySegments(transcriptState, 3), [transcriptState]);
  const latestSegment = visibleSegments.at(-1);
  const selectedCourse = useMemo(
    () => courses.find((course) => course.id === selectedCourseId) ?? null,
    [courses, selectedCourseId]
  );
  const canStart = (status === "idle" || status === "error") && Boolean(activeSessionId || selectedCourse);
  const isConnected = status === "recording" || status === "paused" || status === "connecting";

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const loaded = await loadSettings();
        if (active) setSettings(loaded);
      } catch {
        if (active) setErrorMessage("读取本机设置失败。");
      }
      await refreshCourses(active);
      try {
        const remoteSessions = await listRemoteSessions({ limit: 100 });
        if (!active) return;
        setSessions(remoteSessions);
        const unfinished = remoteSessions.find((session) => session.status === "recording" || session.status === "failed");
        if (unfinished) {
          const fullSession = await getRemoteSession(unfinished.id);
          if (active) restoreUnfinishedSession(fullSession);
        }
      } catch {
        if (active) setErrorMessage("读取服务器记录失败。");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    transcriptRef.current = transcriptState;
  }, [transcriptState]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (!startedAt || !activeSessionId) return;
    const interval = window.setInterval(() => setElapsedMs(Date.now() - startedAt.getTime()), 500);
    return () => window.clearInterval(interval);
  }, [startedAt, activeSessionId]);

  useEffect(() => {
    if (!activeSessionId || !writerLeaseTokenRef.current || (status !== "recording" && status !== "paused")) return;
    const interval = window.setInterval(() => {
      queuePersistence("checkpoint").catch(handlePersistenceFailure);
    }, CHECKPOINT_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [activeSessionId, status]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "hidden" && activeSessionIdRef.current && writerLeaseTokenRef.current) {
        void queuePersistence("checkpoint").catch(handlePersistenceFailure);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  useEffect(() => {
    return () => {
      connectionGenerationRef.current += 1;
      void clientRef.current?.stopAndFlush(750);
      if (commitTimerRef.current) window.clearTimeout(commitTimerRef.current);
      if (activeSessionIdRef.current && writerLeaseTokenRef.current) {
        void queuePersistence("checkpoint").catch(() => undefined);
      }
    };
  }, []);

  async function refreshCourses(stillMounted = true) {
    setCoursesLoading(true);
    try {
      const result = await fetchCourses(false);
      if (!stillMounted) return;
      setCourses(result.courses);
      setCourseNotice(result.stale ? result.warning ?? "课程列表来自缓存，稍后会再次刷新。" : "");
    } catch (error) {
      if (!stillMounted) return;
      setCourses([DAILY_COURSE]);
      setCourseNotice(error instanceof Error ? `Hanyang 课程暂时无法读取：${error.message}` : "Hanyang 课程暂时无法读取。");
    } finally {
      if (stillMounted) setCoursesLoading(false);
    }
  }

  async function refreshSessions() {
    setSessions(await listRemoteSessions({ limit: 100 }));
  }

  function restoreUnfinishedSession(session: ClassSession) {
    const restored: TranscriptState = { segments: session.segments, activeSegment: null };
    setTranscriptState(restored);
    transcriptRef.current = restored;
    setActiveSession(session.id, new Date(session.startedAt));
    setSelectedCourseId(session.courseId);
    recordingCourseRef.current = courseFromSession(session);
    savedSegmentSignaturesRef.current = signaturesFor(session.segments);
    writerLeaseTokenRef.current = null;
    sessionRevisionRef.current = session.revision;
    const recoveryWarning = session.finalizationWarning ?? INCOMPLETE_FINALIZATION_WARNING;
    setActiveFinalizationWarning(recoveryWarning);
    setConnectionStatus("error");
    setErrorMessage("检测到另一页面可能仍在录制的未结束记录。仅查看不会改动它；点击继续或结束时会先明确询问是否接管。");
  }

  function setActiveSession(id: string | null, started: Date | null) {
    activeSessionIdRef.current = id;
    startedAtRef.current = started;
    setActiveSessionId(id);
    setStartedAt(started);
  }

  function setWriterLease(token: string | null, revision: number | null) {
    writerLeaseTokenRef.current = token;
    sessionRevisionRef.current = revision;
  }

  function setConnectionStatus(next: ConnectionStatus) {
    statusRef.current = next;
    setStatus(next);
  }

  function handleWriterLeaseConflict(error: unknown): boolean {
    if (!isWriterLeaseConflictError(error)) return false;
    connectionGenerationRef.current += 1;
    void clientRef.current?.stopAndFlush(1_000).catch(() => undefined);
    clientRef.current = null;
    writerLeaseTokenRef.current = null;
    if (error.currentRevision !== undefined) sessionRevisionRef.current = error.currentRevision;
    setConnectionStatus("error");
    setErrorMessage("这条记录已被另一台设备或页面接管。当前页面已停止录音且不会继续写入；如需接管，请再次点击继续并确认。");
    void refreshSessions().catch(() => undefined);
    return true;
  }

  function handlePersistenceFailure(error: unknown) {
    if (!handleWriterLeaseConflict(error)) {
      setErrorMessage("自动保存暂时失败，将继续重试。");
    }
  }

  async function persistSettings(nextSettings: AppSettings) {
    setSettings(nextSettings);
    await saveSettings(nextSettings);
  }

  async function startClass() {
    if (statusRef.current === "connecting" || statusRef.current === "closing") return;
    if (!activeSessionIdRef.current && !selectedCourse) {
      setErrorMessage("请先选择 Hanyang 课程，或选择日常 / 不选课程。");
      return;
    }
    setErrorMessage("");
    setViewMode("live");
    setConnectionStatus("connecting");
    checkpointQueueRef.current.discardPending();
    const connectionGeneration = ++connectionGenerationRef.current;
    let finishPreparation!: () => void;
    const preparation = new Promise<void>((resolve) => { finishPreparation = resolve; });
    startPreparationRef.current = preparation;
    let preparationFinished = false;
    const markPreparationFinished = () => {
      if (preparationFinished) return;
      preparationFinished = true;
      finishPreparation();
      if (startPreparationRef.current === preparation) startPreparationRef.current = null;
    };
    const startIsCurrent = () => connectionGeneration === connectionGenerationRef.current;

    try {
      await waitForCheckpointQueue();
      if (!startIsCurrent()) {
        markPreparationFinished();
        return;
      }
      if (activeSessionIdRef.current) {
        if (writerLeaseTokenRef.current && sessionRevisionRef.current !== null) {
          const resumed = await resumeRemoteSession(activeSessionIdRef.current, {
            takeover: false,
            writerLeaseToken: writerLeaseTokenRef.current,
            expectedRevision: sessionRevisionRef.current
          });
          setWriterLease(resumed.writerLease.token, resumed.session.revision);
          recordingCourseRef.current = courseFromSession(resumed.session);
          setActiveFinalizationWarning(resumed.session.finalizationWarning ?? finalizationWarningRef.current);
          if (!startIsCurrent()) {
            markPreparationFinished();
            return;
          }
        } else {
          const takenOver = await takeOverActiveSession();
          if (!takenOver) {
            markPreparationFinished();
            setConnectionStatus("error");
            return;
          }
          if (!startIsCurrent()) {
            markPreparationFinished();
            return;
          }
        }
      } else {
        const startTime = new Date();
        const initialState = createTranscriptState();
        const created = await createRemoteSession({
          courseId: selectedCourse!.id,
          startedAt: startTime.toISOString(),
          models: currentModels()
        });
        setActiveSession(created.session.id, startTime);
        setWriterLease(created.writerLease.token, created.session.revision);
        recordingCourseRef.current = courseFromSession(created.session);
        setTranscriptState(initialState);
        transcriptRef.current = initialState;
        savedSegmentSignaturesRef.current.clear();
        setActiveFinalizationWarning(null);
        setElapsedMs(0);
        if (!startIsCurrent()) {
          markPreparationFinished();
          return;
        }
      }

      markPreparationFinished();
      if (!startIsCurrent()) return;
      const getClientSecret = async (signal?: AbortSignal) => (
        await createRealtimeClientSecret(settings.translationMode, signal)
      ).clientSecret;
      const elapsedBaseMs = connectionElapsedBase(getAllSegments(transcriptRef.current), startedAtRef.current);
      const callbacks = {
        onOpen: () => {
          if (connectionGeneration === connectionGenerationRef.current) setConnectionStatus("recording");
        },
        onDelta: (delta: RealtimeTranscriptDelta) => {
          if (connectionGeneration !== connectionGenerationRef.current) return;
          handleRealtimeDelta({
            ...delta,
            elapsedMs: delta.elapsedMs === undefined ? undefined : elapsedBaseMs + delta.elapsedMs
          });
        },
        onSegment: (segment: RealtimeTranscriptSegment) => {
          if (connectionGeneration !== connectionGenerationRef.current) return;
          handleRealtimeSegment({
            ...segment,
            elapsedMs: segment.elapsedMs === undefined ? undefined : elapsedBaseMs + segment.elapsedMs
          });
        },
        onError: (message: string) => {
          if (connectionGeneration === connectionGenerationRef.current) void handleConnectionFailure(message);
        },
        onClose: () => {
          if (connectionGeneration === connectionGenerationRef.current && activeSessionIdRef.current) {
            if (statusRef.current !== "closing") setConnectionStatus("error");
          }
        }
      };
      const client: LiveSubtitleClient =
        settings.translationMode === "realtime-translate"
          ? new RealtimeTranslationClient(getClientSecret, callbacks)
          : new RealtimeTranscriptionTranslationClient(
              getClientSecret,
              settings.textTranslationModel,
              callbacks,
              nextCommitSequence(getAllSegments(transcriptRef.current))
            );
      if (!startIsCurrent()) return;
      clientRef.current = client;
      if (!startIsCurrent()) {
        clientRef.current = null;
        return;
      }
      await client.start();
      if (connectionGeneration !== connectionGenerationRef.current) {
        await client.stopAndFlush(750).catch(() => undefined);
      }
    } catch (error) {
      markPreparationFinished();
      if (connectionGeneration !== connectionGenerationRef.current) return;
      if (handleWriterLeaseConflict(error)) return;
      await handleConnectionFailure(error instanceof Error ? error.message : "无法启动麦克风或 Realtime 连接。");
    }
  }

  async function takeOverActiveSession(): Promise<ClassSession | null> {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return null;
    const confirmed = window.confirm(
      "这条记录可能仍由另一台设备或另一个页面录制。是否接管写入？\n\n接管后，旧页面将不能再保存；记录会标注接管前最后一段字幕无法确认。"
    );
    if (!confirmed) {
      setErrorMessage("未接管记录；另一设备可以继续录制，不会受到当前页面影响。");
      return null;
    }
    const expectedRevision = sessionRevisionRef.current;
    if (expectedRevision === null) {
      setErrorMessage("无法确认记录版本，请刷新页面后再接管。");
      return null;
    }
    const takenOver = await resumeRemoteSession(sessionId, { takeover: true, expectedRevision });
    const session = takenOver.session;
    const restored: TranscriptState = { segments: session.segments, activeSegment: null };
    setTranscriptState(restored);
    transcriptRef.current = restored;
    setActiveSession(session.id, new Date(session.startedAt));
    setSelectedCourseId(session.courseId);
    recordingCourseRef.current = courseFromSession(session);
    savedSegmentSignaturesRef.current = signaturesFor(session.segments);
    setWriterLease(takenOver.writerLease.token, session.revision);
    setActiveFinalizationWarning(session.finalizationWarning ?? INCOMPLETE_FINALIZATION_WARNING);
    return session;
  }

  function currentModels() {
    return {
      translation: settings.translationMode === "realtime-translate" ? "gpt-realtime-translate" as const : settings.textTranslationModel,
      transcription: "gpt-realtime-whisper" as const,
      mode: settings.translationMode
    };
  }

  async function handleConnectionFailure(message: string) {
    clientRef.current = null;
    latchIncompleteFinalization();
    setConnectionStatus("error");
    setErrorMessage(`${message} 已保存当前字幕，但最后一段可能缺失。继续录制，或再次点击结束并明确确认不完整记录。`);
    if (activeSessionIdRef.current) {
      await queuePersistence("failed").catch((error) => {
        handlePersistenceFailure(error);
      });
    }
  }

  function handleRealtimeDelta(delta: RealtimeTranscriptDelta) {
    const next = applyTranscriptDelta(transcriptRef.current, delta);
    transcriptRef.current = next;
    setTranscriptState(next);
    scheduleCommit();
  }

  function handleRealtimeSegment(segment: RealtimeTranscriptSegment) {
    const next = appendTranscriptSegment(transcriptRef.current, segment);
    transcriptRef.current = next;
    setTranscriptState(next);
  }

  function scheduleCommit() {
    if (commitTimerRef.current) window.clearTimeout(commitTimerRef.current);
    commitTimerRef.current = window.setTimeout(() => {
      const next = commitActiveSegment(transcriptRef.current);
      transcriptRef.current = next;
      setTranscriptState(next);
    }, COMMIT_DELAY_MS);
  }

  function pauseClass() {
    clientRef.current?.pause();
    setConnectionStatus("paused");
    void queuePersistence("checkpoint").catch(handlePersistenceFailure);
  }

  function resumeClass() {
    clientRef.current?.resume();
    setConnectionStatus("recording");
  }

  async function endClass() {
    const cancellingStartup = statusRef.current === "connecting";
    if (cancellingStartup) {
      connectionGenerationRef.current += 1;
      const pendingClient = clientRef.current;
      clientRef.current = null;
      await pendingClient?.stopAndFlush(750).catch(() => undefined);
      const preparation = startPreparationRef.current;
      if (preparation && !(await waitForPromise(preparation, CHECKPOINT_DRAIN_TIMEOUT_MS))) {
        setConnectionStatus("error");
        setErrorMessage("启动请求仍未在限定时间内结束，已取消麦克风连接。请在网络稳定后重试。");
        return;
      }
    }
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      setConnectionStatus("idle");
      return;
    }
    if (!writerLeaseTokenRef.current || sessionRevisionRef.current === null) {
      try {
        const takenOver = await takeOverActiveSession();
        if (!takenOver) return;
      } catch (error) {
        if (!handleWriterLeaseConflict(error)) {
          setConnectionStatus("error");
          setErrorMessage(error instanceof Error ? `无法接管记录：${error.message}` : "无法接管记录。");
        }
        return;
      }
    }
    if (!clientRef.current && !finalizationWarningRef.current && !cancellingStartup) {
      latchIncompleteFinalization();
      await persistWithUncertainWriteRecovery("failed", true).catch(() => undefined);
      setConnectionStatus("error");
      setErrorMessage("当前没有可确认尾段的 Realtime 连接。记录仍为失败状态；再次点击结束可明确选择保存不完整记录。");
      return;
    }
    let acceptIncomplete = false;
    if (finalizationWarningRef.current) {
      acceptIncomplete = window.confirm(
        "这条记录的最后一段字幕可能缺失。是否以当前已保存字幕结束？\n\n确认后记录会标注“字幕可能不完整”，不会被当作完整逐字稿。"
      );
      if (!acceptIncomplete) {
        setConnectionStatus("error");
        setErrorMessage("未结束记录。你可以继续录制，或再次点击结束并确认保存不完整字幕。");
        return;
      }
    }
    setConnectionStatus("closing");
    checkpointQueueRef.current.discardPending();
    setErrorMessage("");
    if (commitTimerRef.current) window.clearTimeout(commitTimerRef.current);

    try {
      if (clientRef.current) await clientRef.current.stopAndFlush(5_000);
      connectionGenerationRef.current += 1;
      clientRef.current = null;
      if (commitTimerRef.current) window.clearTimeout(commitTimerRef.current);
    } catch (error) {
      connectionGenerationRef.current += 1;
      clientRef.current = null;
      latchIncompleteFinalization();
      const finalTranscript = commitActiveSegment(transcriptRef.current);
      setTranscriptState(finalTranscript);
      transcriptRef.current = finalTranscript;
      let leaseLost = false;
      await persistFailureAfterCheckpointQueue(true).catch((persistenceError) => {
        leaseLost = handleWriterLeaseConflict(persistenceError);
        if (!leaseLost) handlePersistenceFailure(persistenceError);
      });
      if (leaseLost) return;
      setConnectionStatus("error");
      setErrorMessage(error instanceof Error
        ? `结束时未能确认最后一段：${error.message}。当前字幕已保留且记录仍为失败状态；再次点击结束可明确选择保存不完整记录。`
        : "结束时未能确认最后一段。当前字幕已保留且记录仍为失败状态；再次点击结束可明确选择保存不完整记录。");
      return;
    }

    try {
      const finalTranscript = commitActiveSegment(transcriptRef.current);
      setTranscriptState(finalTranscript);
      transcriptRef.current = finalTranscript;
      await waitForCheckpointQueue();
      await persistWithUncertainWriteRecovery("checkpoint", true);
      if (finalizationWarningRef.current) {
        if (!acceptIncomplete) {
          await persistWithUncertainWriteRecovery("failed", true).catch(() => undefined);
          setConnectionStatus("error");
          setErrorMessage("最后一段仍未确认，记录保持失败状态。再次点击结束并明确确认后，才能保存为可能不完整的记录。");
          return;
        }
        // Do not rely on an earlier best-effort failure checkpoint. The server
        // must durably store the warning before accepting an incomplete finish.
        await persistWithUncertainWriteRecovery("failed", true);
      }
      const endTime = new Date();
      const started = startedAtRef.current ?? endTime;
      const completionInput = (): CompleteLectureSessionRequest => ({
        endedAt: endTime.toISOString(),
        durationMs: Math.max(0, endTime.getTime() - started.getTime()),
        segments: [],
        ...requireWriterLease(),
        acceptIncomplete: Boolean(finalizationWarningRef.current && acceptIncomplete)
      });
      const saved = await completeWithUncertainWriteRecovery(sessionId, completionInput);
      setSelectedSession(saved);
      setActiveSession(null, null);
      setWriterLease(null, null);
      recordingCourseRef.current = null;
      savedSegmentSignaturesRef.current.clear();
      setActiveFinalizationWarning(null);
      setElapsedMs(0);
      setConnectionStatus("idle");
      setViewMode("document");
      await refreshSessions();
    } catch (error) {
      if (handleWriterLeaseConflict(error)) return;
      latchIncompleteFinalization();
      if (error instanceof CheckpointDrainTimeoutError) {
        void persistFailureAfterCheckpointQueue(true).catch(handlePersistenceFailure);
        setConnectionStatus("error");
        setErrorMessage("自动保存请求超时，结束操作已停止等待。记录保持待恢复并标注字幕可能不完整，可以在网络稳定后重试。");
        return;
      }
      let leaseLost = false;
      await persistFailureAfterCheckpointQueue(true).catch((persistenceError) => {
        leaseLost = handleWriterLeaseConflict(persistenceError);
        if (!leaseLost) handlePersistenceFailure(persistenceError);
      });
      if (leaseLost) return;
      setConnectionStatus("error");
      setErrorMessage(error instanceof Error
        ? `保存尚未完成：${error.message}。记录保持待恢复并标注字幕可能不完整，可以稍后重试。`
        : "保存尚未完成。记录保持待恢复并标注字幕可能不完整，可以稍后重试。");
    }
  }

  function queuePersistence(mode: PersistenceMode): Promise<void> {
    if (mode === "checkpoint" && statusRef.current !== "recording" && statusRef.current !== "paused") {
      return Promise.resolve();
    }
    if (mode === "failed") return persistFailureAfterCheckpointQueue(false);
    return checkpointQueueRef.current.enqueue(() => persistWithUncertainWriteRecovery("checkpoint", false));
  }

  async function waitForCheckpointQueue(): Promise<void> {
    const idle = await checkpointQueueRef.current.waitForIdle(CHECKPOINT_DRAIN_TIMEOUT_MS);
    if (!idle) {
      throw new CheckpointDrainTimeoutError();
    }
  }

  async function persistFailureAfterCheckpointQueue(forceAll: boolean): Promise<void> {
    try {
      await waitForCheckpointQueue();
    } catch (error) {
      if (error instanceof CheckpointDrainTimeoutError || isWriterLeaseConflictError(error)) throw error;
      // A bounded checkpoint request may have failed because the network moved.
      // Its queue is now settled, so a failed-state write can safely retry with
      // the last confirmed revision. A response-lost write will CAS-conflict.
    }
    await persistWithUncertainWriteRecovery("failed", forceAll);
  }

  async function persistWithUncertainWriteRecovery(mode: PersistenceMode, forceAll: boolean): Promise<void> {
    try {
      await persistChangedSegments(mode, forceAll);
    } catch (error) {
      if (!isUncertainWriteError(error)) throw error;
      await recoverCurrentWriterAfterUncertainWrite();
      await persistChangedSegments(mode, forceAll);
    }
  }

  async function recoverCurrentWriterAfterUncertainWrite(): Promise<void> {
    const sessionId = activeSessionIdRef.current;
    const writerLeaseToken = writerLeaseTokenRef.current;
    if (!sessionId || !writerLeaseToken) throw new Error("当前页面没有可恢复的写入租约。");
    const latest = await getRemoteSession(sessionId);
    const resumed = await resumeRemoteSession(sessionId, {
      takeover: false,
      writerLeaseToken,
      expectedRevision: latest.revision
    });
    setWriterLease(resumed.writerLease.token, resumed.session.revision);
    setActiveFinalizationWarning(resumed.session.finalizationWarning ?? finalizationWarningRef.current);
  }

  async function completeWithUncertainWriteRecovery(
    sessionId: string,
    buildInput: () => CompleteLectureSessionRequest
  ): Promise<ClassSession> {
    try {
      return await completeRemoteSession(sessionId, buildInput());
    } catch (error) {
      if (!isUncertainWriteError(error)) throw error;
      const writerLeaseToken = writerLeaseTokenRef.current;
      if (!writerLeaseToken) throw error;
      const latest = await getRemoteSession(sessionId);
      try {
        const resumed = await resumeRemoteSession(sessionId, {
          takeover: false,
          writerLeaseToken,
          expectedRevision: latest.revision
        });
        setWriterLease(resumed.writerLease.token, resumed.session.revision);
      } catch (verificationError) {
        if (
          verificationError instanceof ApiRequestError &&
          verificationError.code === "session_not_writable" &&
          latest.status === "ready"
        ) {
          return latest;
        }
        throw verificationError;
      }
      return completeRemoteSession(sessionId, buildInput());
    }
  }

  async function persistChangedSegments(mode: PersistenceMode, forceAll: boolean) {
    const sessionId = activeSessionIdRef.current;
    const started = startedAtRef.current;
    if (!sessionId || !started || !writerLeaseTokenRef.current || sessionRevisionRef.current === null) return;
    const allSegments = getAllSegments(transcriptRef.current);
    const changed = forceAll
      ? allSegments
      : allSegments.filter((segment) => savedSegmentSignaturesRef.current.get(segment.id) !== segmentSignature(segment));
    const chunks = chunkSegments(changed, CHECKPOINT_BATCH_SIZE);
    const durationMs = Math.max(0, Date.now() - started.getTime());

    if (chunks.length === 0) {
      const saved = mode === "failed"
        ? await failRemoteSession(sessionId, {
            durationMs,
            segments: [],
            ...requireWriterLease(),
            finalizationWarning: finalizationWarningRef.current ?? INCOMPLETE_FINALIZATION_WARNING
          })
        : await checkpointRemoteSession(sessionId, {
            durationMs,
            segments: [],
            ...requireWriterLease()
          });
      sessionRevisionRef.current = saved.revision;
      if (mode === "failed") setActiveFinalizationWarning(saved.finalizationWarning);
      return;
    }
    for (let index = 0; index < chunks.length; index += 1) {
      const segments = chunks[index];
      const isLast = index === chunks.length - 1;
      if (mode === "failed" && isLast) {
        const saved = await failRemoteSession(sessionId, {
          durationMs,
          segments,
          ...requireWriterLease(),
          finalizationWarning: finalizationWarningRef.current ?? INCOMPLETE_FINALIZATION_WARNING
        });
        sessionRevisionRef.current = saved.revision;
        setActiveFinalizationWarning(saved.finalizationWarning);
      } else {
        const saved = await checkpointRemoteSession(sessionId, {
          durationMs,
          segments,
          ...requireWriterLease()
        });
        sessionRevisionRef.current = saved.revision;
      }
      for (const segment of segments) {
        savedSegmentSignaturesRef.current.set(segment.id, segmentSignature(segment));
      }
    }
  }

  function requireWriterLease() {
    const writerLeaseToken = writerLeaseTokenRef.current;
    const expectedRevision = sessionRevisionRef.current;
    if (!writerLeaseToken || expectedRevision === null) {
      throw new Error("当前页面没有这条记录的写入租约。");
    }
    return { writerLeaseToken, expectedRevision };
  }

  function setActiveFinalizationWarning(warning: string | null) {
    finalizationWarningRef.current = warning;
    setFinalizationWarning(warning);
  }

  function latchIncompleteFinalization() {
    if (!finalizationWarningRef.current) {
      setActiveFinalizationWarning(INCOMPLETE_FINALIZATION_WARNING);
    }
  }

  async function openSession(session: ClassSessionSummary) {
    try {
      setSelectedSession(await getRemoteSession(session.id));
      setViewMode("document");
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "读取记录失败。");
    }
  }

  async function exportSession(session: ClassSessionSummary) {
    try {
      downloadMarkdown(await getRemoteSession(session.id));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "导出记录失败。");
    }
  }

  async function removeSession(session: ClassSessionSummary) {
    if (session.status !== "ready") {
      setErrorMessage("只有已经结束的记录可以归档。录制中或待恢复的记录需要先明确结束。");
      return;
    }
    if (!window.confirm("归档这条课堂记录？内容不会从数据库中物理删除。")) return;
    try {
      await archiveRemoteSession(session.id);
      if (selectedSession?.id === session.id) setSelectedSession(null);
      await refreshSessions();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "归档记录失败。");
    }
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
          <span>Study Lecture</span>
        </button>
        <div className="status-strip" aria-live="polite">
          <span className={`status-dot status-${status}`} />
          <span>{statusLabel(status, Boolean(activeSessionId), Boolean(latestSegment))}</span>
          <span className="timer">{formatDuration(elapsedMs)}</span>
        </div>
        <nav className="top-actions" aria-label="主要操作">
          <button className="icon-button" type="button" onClick={() => setSettingsOpen((open) => !open)} title="设置"><Settings size={20} /></button>
          <button className="icon-button secondary-nav" type="button" onClick={() => setViewMode("records")} title="记录"><Library size={20} /></button>
          {status === "paused" ? (
            <button className="primary-action" type="button" onClick={resumeClass} title="继续"><Play size={19} /><span className="control-label">继续</span></button>
          ) : (
            <button className="primary-action" type="button" onClick={startClass} title={activeSessionId ? "继续" : "开始"} disabled={!canStart || isConnected}>
              {activeSessionId ? <Play size={19} /> : <Mic size={19} />}<span className="control-label">{activeSessionId ? "继续" : "开始"}</span>
            </button>
          )}
          {status === "recording" ? <button className="icon-button control" type="button" onClick={pauseClass} title="暂停"><Pause size={20} /></button> : null}
          <button className="icon-button danger" type="button" onClick={endClass} title="结束" disabled={!activeSessionId || status === "closing"}><Square size={18} /></button>
        </nav>
      </header>

      {settingsOpen ? (
        <section className="settings-panel" aria-label="设置">
          <label className="range-field">字号<input value={settings.subtitleScale} min="0.8" max="1.5" step="0.05" onChange={(event) => updateSubtitleScale(Number(event.target.value))} type="range" /></label>
          <button className="ghost-button" type="button" onClick={toggleKoreanInline}>{settings.showKoreanInline ? <EyeOff size={17} /> : <Eye size={17} />}{settings.showKoreanInline ? "隐藏韩文" : "显示韩文"}</button>
          <button className="ghost-button settings-records-link" type="button" onClick={() => { setViewMode("records"); setSettingsOpen(false); }}><Library size={17} />记录</button>
          <button className="icon-button" type="button" onClick={() => setSettingsOpen(false)} title="关闭设置"><X size={18} /></button>
        </section>
      ) : null}

      {courseNotice ? <p className="error-banner">{courseNotice}</p> : null}
      {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}
      {finalizationWarning ? <p className="error-banner">字幕完整性警告：{finalizationWarning}</p> : null}

      <main className="main-surface">
        {viewMode === "live" ? (
          <LiveSubtitleView
            status={status}
            segments={visibleSegments}
            showKorean={settings.showKoreanInline}
            courses={courses}
            coursesLoading={coursesLoading}
            selectedCourseId={selectedCourseId}
            canChooseCourse={!activeSessionId}
            onSelectCourse={setSelectedCourseId}
            onRefreshCourses={() => void refreshCourses()}
          />
        ) : null}
        {viewMode === "records" ? <RecordsView sessions={sessions} onSelect={openSession} onArchive={removeSession} onExport={exportSession} /> : null}
        {viewMode === "document" ? <DocumentView session={selectedSession} onBack={() => setViewMode("records")} onExport={downloadMarkdown} /> : null}
      </main>
    </div>
  );
}

function LiveSubtitleView({ status, segments, showKorean, courses, coursesLoading, selectedCourseId, canChooseCourse, onSelectCourse, onRefreshCourses }: {
  status: ConnectionStatus;
  segments: ReturnType<typeof getDisplaySegments>;
  showKorean: boolean;
  courses: CourseOption[];
  coursesLoading: boolean;
  selectedCourseId: string;
  canChooseCourse: boolean;
  onSelectCourse: (courseId: string) => void;
  onRefreshCourses: () => void;
}) {
  const hasText = segments.some((segment) => segment.translatedText.trim());
  if (!hasText) {
    return (
      <section className="subtitle-stage empty-stage">
        {canChooseCourse ? <CoursePicker courses={courses} coursesLoading={coursesLoading} selectedCourseId={selectedCourseId} onSelectCourse={onSelectCourse} onRefresh={onRefreshCourses} /> : null}
        <p className="empty-subtitle">{emptyMessage(status, Boolean(selectedCourseId))}</p>
      </section>
    );
  }
  return (
    <section className="subtitle-stage" aria-live="polite">
      <div className="subtitle-stack">
        {segments.map((segment, index) => (
          <article className={`subtitle-line ${index === segments.length - 1 ? "latest" : "previous"}`} key={segment.id}>
            <p>{segment.translatedText.trim()}</p>
            {showKorean && segment.sourceText.trim() ? <small>{segment.sourceText.trim()}</small> : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function CoursePicker({ courses, coursesLoading, selectedCourseId, onSelectCourse, onRefresh }: {
  courses: CourseOption[];
  coursesLoading: boolean;
  selectedCourseId: string;
  onSelectCourse: (courseId: string) => void;
  onRefresh: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(!selectedCourseId);
  const selectedCourse = courses.find((course) => course.id === selectedCourseId) ?? null;
  const gridId = "course-picker-grid";
  useEffect(() => { if (!selectedCourseId) setIsExpanded(true); }, [selectedCourseId]);
  if (!isExpanded && selectedCourse) {
    return (
      <div className="course-picker course-picker-compact" aria-label="选择课程">
        <button className="course-picker-toggle" type="button" aria-expanded={false} aria-controls={gridId} onClick={() => setIsExpanded(true)}>
          <FolderOpen size={18} aria-hidden="true" /><span className="course-picker-summary"><strong>{selectedCourse.name}</strong><span>{courseMeta(selectedCourse)}</span></span><span className="course-picker-change">更换</span><ChevronDown size={18} aria-hidden="true" />
        </button>
      </div>
    );
  }
  const academicCourseCount = courses.filter((course) => course.source === "canvas").length;
  return (
    <div className="course-picker" aria-label="选择课程">
      <button className="course-picker-title" type="button" aria-expanded={true} aria-controls={gridId} disabled={!selectedCourse} onClick={() => setIsExpanded(false)}>
        <FolderOpen size={18} aria-hidden="true" /><span>选择 Hanyang 课程</span>{selectedCourse ? <ChevronUp size={16} aria-hidden="true" /> : null}
      </button>
      <button className="ghost-button" type="button" onClick={onRefresh} disabled={coursesLoading}><RefreshCw size={16} />{coursesLoading ? "刷新中" : "刷新课程"}</button>
      {academicCourseCount === 0 && !coursesLoading ? <p className="muted">Canvas 当前返回 0 门课程，这是正常状态；仍可选择日常记录。</p> : null}
      <div className="course-grid" id={gridId}>
        {courses.map((course) => (
          <button className={`course-button ${course.id === selectedCourseId ? "selected" : ""}`} type="button" key={course.id} aria-pressed={course.id === selectedCourseId} onClick={() => { onSelectCourse(course.id); setIsExpanded(false); }}>
            <strong>{course.name}</strong><span>{courseMeta(course)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function RecordsView({ sessions, onSelect, onArchive, onExport }: {
  sessions: ClassSessionSummary[];
  onSelect: (session: ClassSessionSummary) => void;
  onArchive: (session: ClassSessionSummary) => void;
  onExport: (session: ClassSessionSummary) => void;
}) {
  const groups = groupSessionsByCourse(sessions);
  return (
    <section className="records-view">
      <div className="section-heading"><BookOpen size={22} /><h1>课堂记录</h1></div>
      {sessions.length === 0 ? <p className="muted">课堂开始后，字幕会持续保存到服务器。</p> : (
        <div className="session-groups">
          {groups.map((group) => (
            <section className="session-course-group" key={group.key}>
              <h2>{group.courseName}</h2>{group.courseTerm ? <p>{group.courseTerm}</p> : null}
              <ul className="session-list">
                {group.sessions.map((session) => (
                  <li className="session-row" key={session.id}>
                    <button type="button" onClick={() => onSelect(session)}><strong>{session.title}</strong><span>{formatDateTime(session.startedAt)} · {formatDuration(session.durationMs)} · {session.segmentCount} 段 · {sessionStatusLabel(session.status, session.finalizationWarning)}{session.courseMatchStatus === "legacy_unmatched" ? " · 旧课程未匹配" : ""}</span></button>
                    <div className="row-actions"><button className="icon-button" type="button" onClick={() => onExport(session)} title="导出 Markdown"><Download size={18} /></button>{session.status === "ready" ? <button className="icon-button danger" type="button" onClick={() => onArchive(session)} title="归档"><Trash2 size={18} /></button> : null}</div>
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

function DocumentView({ session, onBack, onExport }: { session: ClassSession | null; onBack: () => void; onExport: (session: ClassSession) => void }) {
  if (!session) return <section className="records-view"><p className="muted">没有选中的课堂记录。</p><button className="ghost-button" type="button" onClick={onBack}>返回记录</button></section>;
  return (
    <section className="document-view">
      <div className="document-header"><button className="ghost-button" type="button" onClick={onBack}>返回</button><div><h1>{session.title}</h1><p>{session.courseName}{session.courseTerm ? ` · ${session.courseTerm}` : ""} · {formatDateTime(session.startedAt)} · {formatDuration(session.durationMs)} · {sessionStatusLabel(session.status, session.finalizationWarning)}</p></div><button className="primary-action" type="button" onClick={() => onExport(session)}><Download size={18} /><span className="control-label">Markdown</span></button></div>
      {session.finalizationWarning ? <p className="error-banner">字幕完整性警告：{session.finalizationWarning}</p> : null}
      <div className="document-body">{session.segments.length === 0 ? <p className="muted">这节课还没有保存到字幕文本。</p> : session.segments.map((segment) => <article className="transcript-block" key={segment.id}><time>{formatTimestamp(segment.startedAtMs)}</time><p className="zh-text">{segment.translatedText.trim() || "无中文译文"}</p><details><summary>韩文原文</summary><p lang="ko">{segment.sourceText.trim() || "无韩文原文"}</p></details></article>)}</div>
    </section>
  );
}

function statusLabel(status: ConnectionStatus, hasActiveSession: boolean, hasText: boolean): string {
  if (status === "connecting") return "连接中";
  if (status === "recording") return "录制中";
  if (status === "paused") return "已暂停";
  if (status === "closing") return "保存中";
  if (status === "error") return hasActiveSession ? "待恢复" : "错误";
  return hasText ? "已就绪" : "待开始";
}

function sessionStatusLabel(status: ClassSessionSummary["status"], warning: string | null): string {
  const base = { recording: "录制中", ready: "已结束", failed: "待恢复", archived: "已归档" }[status];
  return warning ? `${base}（字幕可能不完整）` : base;
}

function emptyMessage(status: ConnectionStatus, hasCourse: boolean) {
  if (!hasCourse) return "请选择课程或日常";
  if (status === "connecting") return "正在连接...";
  if (status === "recording") return "正在听...";
  if (status === "paused") return "已暂停";
  if (status === "error") return "可以继续或结束保存";
  return "准备开始";
}

function courseMeta(course: CourseOption) {
  return course.id === DAILY_COURSE_ID ? "日常" : `${course.code || course.id}${course.term ? ` · ${course.term}` : ""}`;
}

function courseFromSession(session: ClassSession): CourseOption {
  return {
    id: session.courseId,
    code: session.courseCode,
    name: session.courseName,
    term: session.courseTerm,
    folderName: session.courseFolderName,
    label: session.courseName,
    source: session.courseMatchStatus === "daily" ? "daily" : session.courseMatchStatus === "matched" ? "canvas" : "legacy",
    workflowState: null,
    startAt: null,
    endAt: null,
    isArchived: session.status === "archived"
  };
}

function segmentSignature(segment: TranscriptSegment): string {
  return `${segment.commitSequence ?? ""}|${segment.startedAtMs}|${segment.endedAtMs ?? ""}|${segment.sourceText}|${segment.translatedText}|${segment.isFinal}`;
}

function signaturesFor(segments: TranscriptSegment[]): Map<string, string> {
  return new Map(segments.map((segment) => [segment.id, segmentSignature(segment)]));
}

function chunkSegments(segments: TranscriptSegment[], size: number): TranscriptSegment[][] {
  const chunks: TranscriptSegment[][] = [];
  for (let index = 0; index < segments.length; index += size) chunks.push(segments.slice(index, index + size));
  return chunks;
}

function groupSessionsByCourse(sessions: ClassSessionSummary[]) {
  const groups = new Map<string, { key: string; courseName: string; courseTerm: string; sessions: ClassSessionSummary[] }>();
  for (const session of sessions) {
    const key = `${session.courseMatchStatus}:${session.courseId}:${session.courseTerm}`;
    const group = groups.get(key);
    if (group) group.sessions.push(session);
    else groups.set(key, { key, courseName: session.courseName, courseTerm: session.courseTerm, sessions: [session] });
  }
  return Array.from(groups.values());
}
