import { z } from "zod";
import { readBoundedText } from "./client.js";
import { schoolIdSchema, type SchoolImport } from "./school-types.js";

const metadataSchema = z.object({
  course_id: z.union([z.string(), z.number()]).transform(String),
  learningx_module_item_id: z.union([z.string(), z.number()]).transform(String).nullable().optional(),
  viewer_public: z.boolean(), has_password: z.boolean(), language_code: z.string(),
  recording_status: z.string().max(80),
  recording_start_time: z.string().datetime({ offset: true }).nullable(),
  recording_end_time: z.string().datetime({ offset: true }).nullable(),
});
const captionSchema = z.object({
  order: z.number().int().min(0).max(1_000_000),
  text: z.string().max(40_000), language_code: z.string(),
  speech_start_ms: z.number().nonnegative().nullable().default(null),
  speech_end_ms: z.number().nonnegative().nullable().default(null),
  is_final: z.boolean().default(true),
});
type Caption = z.infer<typeof captionSchema>;
export interface SchoolViewer { courseId: string; viewerId: string; moduleItemId: string | null; title: string }

export class SchoolReadError extends Error {
  constructor(public readonly code: "permission" | "unavailable" | "invalid" | "timeout") { super(code); }
}

/** Keeps the school's sentence identity across history, partial text and corrections. */
export class SchoolCaptionBuffer {
  readonly korean = new Map<number, Caption>();
  readonly chinese = new Map<number, Caption>();
  private readonly corrections = new Map<number, string>();
  private readonly beforeHistory = new Map<number, Caption>();
  private hasHistory = false;
  constructor(private readonly viewerId: string) {}

  apply(event: string, payload: unknown): boolean {
    if (event === "stt_socket_event_caption_list") {
      for (const caption of z.array(captionSchema).max(20_000).parse(payload)) {
        if (caption.language_code === "ko") this.korean.set(caption.order, caption);
      }
      for (const [order, caption] of this.beforeHistory) this.korean.set(order, caption);
      this.beforeHistory.clear(); this.hasHistory = true;
    } else if (event === "stt_socket_event_speech_recognized") {
      const caption = captionSchema.parse(payload);
      if (caption.language_code !== "ko") return false;
      const previous = this.korean.get(caption.order);
      if (previous?.is_final && !caption.is_final) return false;
      caption.speech_start_ms ??= previous?.speech_start_ms ?? null;
      caption.speech_end_ms ??= previous?.speech_end_ms ?? null;
      this.korean.set(caption.order, caption);
      if (!this.hasHistory) this.beforeHistory.set(caption.order, caption);
    } else if (event === "stt_socket_event_speech_post_processed") {
      const correction = z.object({ order: z.number().int().nonnegative(), correctedText: z.string().max(40_000) }).parse(payload);
      this.corrections.set(correction.order, correction.correctedText);
    } else if (event === "translate_socket_translate_caption_list_completed") {
      const history = z.object({ translive_id: z.union([z.string(), z.number()]).optional(), language_code: z.string(),
        captions: z.array(captionSchema).max(20_000) }).parse(payload);
      if (history.language_code !== "zh-CN" || (history.translive_id !== undefined && String(history.translive_id) !== this.viewerId)) return false;
      for (const caption of history.captions) if (caption.language_code === "zh-CN") this.chinese.set(caption.order, caption);
    } else if (event === "translate_socket_translate_caption_completed" || event === "translate_socket_translate_caption_processing") {
      const translated = z.object({ translive_id: z.union([z.string(), z.number()]), language_code: z.string(), caption: captionSchema }).parse(payload);
      if (String(translated.translive_id) !== this.viewerId || translated.language_code !== "zh-CN") return false;
      this.chinese.set(translated.caption.order, translated.caption);
    } else return false;
    if (this.korean.size > 20_000 || this.chinese.size > 20_000 || this.corrections.size > 20_000) throw new SchoolReadError("invalid");
    if ([...this.korean.values(), ...this.chinese.values()].reduce((bytes, caption) => bytes + caption.text.length * 2, 0) > 16 * 1024 * 1024) throw new SchoolReadError("invalid");
    return this.hasHistory;
  }

  segments(): SchoolImport["segments"] {
    const korean = [...this.korean.values()].map(caption => ({ ...caption, text: this.corrections.get(caption.order) ?? caption.text }));
    return mergeCaptions(korean, [...this.chinese.values()]);
  }
}

/** A viewer-only live connection. Korean arrives as partial/final/correction events.
 * Chinese is also refreshed using existing-history reads, without language subscription
 * or translation-generation commands. Reconnection always requests the full history.
 */
export async function watchSchoolCaptions(initial: SchoolImport, signal: AbortSignal,
  save: (snapshot: SchoolImport) => Promise<void>, fetchImpl = globalThis.fetch,
  socketFactory = (url: string) => new WebSocket(url)): Promise<void> {
  if (signal.aborted) return;
  const buffer = new SchoolCaptionBuffer(initial.viewerId);
  let metadata = initial;
  let dirty = false;
  let flushing = false;
  let refreshing = false;
  let lastPacket = Date.now();
  await new Promise<void>((resolve, reject) => {
    const socket = socketFactory(`wss://learning.hanyang.ac.kr/translive-socket-server/?EIO=4&transport=websocket&translive_id=${initial.viewerId}`);
    let done = false;
    let connected = false;
    const finish = (error?: SchoolReadError) => {
      if (done) return;
      done = true; clearInterval(persistenceTimer); clearInterval(historyTimer); clearInterval(metadataTimer);
      signal.removeEventListener("abort", abort); socket.close();
      if (error) reject(error); else resolve();
    };
    const abort = () => finish();
    const requestChinese = () => {
      if (connected && !done) socket.send('42["translation_socket_event_translate_caption_list",{"language_code":"zh-CN"}]');
    };
    async function flush() {
      if (flushing || done || !dirty) return;
      flushing = true; dirty = false;
      try { await save({ ...metadata, segments: buffer.segments() }); }
      catch { finish(new SchoolReadError("unavailable")); }
      finally { flushing = false; }
    }
    async function refreshMetadata() {
      if (done || refreshing) return;
      refreshing = true;
      try {
        const response = await fetchImpl(`https://learning.hanyang.ac.kr/translive-api-server/sessions/${initial.viewerId}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), redirect: "manual",
        });
        if (!response.ok) throw new SchoolReadError("unavailable");
        const current = metadataSchema.parse(JSON.parse(await readBoundedText(response, 128 * 1024)));
        if (!current.viewer_public || current.has_password) throw new SchoolReadError("permission");
        if (current.course_id !== initial.courseId || current.language_code !== "ko" ||
          (initial.moduleItemId !== null && current.learningx_module_item_id !== initial.moduleItemId)) throw new SchoolReadError("invalid");
        const endedAt = current.recording_end_time ? new Date(current.recording_end_time).toISOString() : null;
        if (current.recording_status !== metadata.recordingStatus || endedAt !== metadata.endedAt) {
          metadata = { ...metadata, recordingStatus: current.recording_status, endedAt }; dirty = true;
        }
        // Allow late corrections and translations after the teacher stops.
        if (endedAt && Date.now() - Date.parse(endedAt) > 10 * 60_000) { await flush(); finish(); }
      } catch (error) { finish(error instanceof SchoolReadError ? error : new SchoolReadError("unavailable")); }
      finally { refreshing = false; }
    }
    const persistenceTimer = setInterval(() => { if (Date.now() - lastPacket > 60_000) finish(new SchoolReadError("timeout")); else void flush(); }, 1_000);
    const historyTimer = setInterval(requestChinese, 5_000);
    const metadataTimer = setInterval(() => void refreshMetadata(), 60_000);
    signal.addEventListener("abort", abort, { once: true });
    socket.addEventListener("error", () => finish(new SchoolReadError("unavailable")));
    socket.addEventListener("close", () => { if (!done) finish(new SchoolReadError("unavailable")); });
    socket.addEventListener("message", ({ data }) => {
      if (done || typeof data !== "string") return;
      lastPacket = Date.now();
      if (Buffer.byteLength(data) > 8 * 1024 * 1024) { finish(new SchoolReadError("invalid")); return; }
      try {
        if (data.startsWith("0")) socket.send('40{"token":null,"vtoken":null,"ptoken":null}');
        else if (data === "2") socket.send("3");
        else if (data.startsWith("40")) { connected = true; requestChinese(); }
        else if (data.startsWith("44")) finish(new SchoolReadError("permission"));
        else if (data.startsWith("42")) {
          const [event, payload] = JSON.parse(data.slice(2)) as [string, unknown];
          if (buffer.apply(event, payload)) dirty = true;
          if (event === "recording_status_change") void refreshMetadata();
          if (event.includes("error")) finish(new SchoolReadError("unavailable"));
        }
      } catch { finish(new SchoolReadError("invalid")); }
    });
  });
}

export async function readSchoolCaptions(viewer: SchoolViewer, signal: AbortSignal,
  fetchImpl = globalThis.fetch, socketFactory = (url: string) => new WebSocket(url)): Promise<SchoolImport | null> {
  schoolIdSchema.parse(viewer.viewerId);
  const response = await fetchImpl(`https://learning.hanyang.ac.kr/translive-api-server/sessions/${viewer.viewerId}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), redirect: "manual",
  });
  if (!response.ok) throw new SchoolReadError(response.status === 401 || response.status === 403 ? "permission" : "unavailable");
  const parsed = metadataSchema.safeParse(JSON.parse(await readBoundedText(response, 128 * 1024)));
  if (!parsed.success) throw new SchoolReadError("invalid");
  const metadata = parsed.data;
  if (!metadata.viewer_public || metadata.has_password) throw new SchoolReadError("permission");
  if (metadata.course_id !== viewer.courseId || metadata.language_code !== "ko" ||
    (viewer.moduleItemId !== null && metadata.learningx_module_item_id !== viewer.moduleItemId)) throw new SchoolReadError("invalid");
  if (!metadata.recording_start_time) return null;
  const history = await receiveHistory(viewer.viewerId, signal, socketFactory);
  return { ...viewer, startedAt: new Date(metadata.recording_start_time).toISOString(),
    endedAt: metadata.recording_end_time ? new Date(metadata.recording_end_time).toISOString() : null,
    recordingStatus: metadata.recording_status, segments: mergeCaptions(history.korean, history.chinese) };
}

export function mergeCaptions(korean: Caption[], chinese: Caption[]): SchoolImport["segments"] {
  const translations = new Map(chinese.filter(caption => caption.language_code === "zh-CN").map(caption => [caption.order, caption.text]));
  return [...new Map(korean.filter(caption => caption.language_code === "ko").map(caption => [caption.order, caption])).values()]
    .sort((a, b) => a.order - b.order).map(caption => ({ order: caption.order,
      startedAtMs: Math.round(caption.speech_start_ms ?? 0),
      endedAtMs: caption.speech_end_ms === null ? null : Math.round(caption.speech_end_ms),
      sourceText: caption.text, translatedText: translations.get(caption.order) ?? "", isFinal: caption.is_final }));
}

/** Socket.IO viewer handshake plus the one observed existing-history read event.
 * Never send recording, language-selection, FORCE, or translation-generation commands.
 * Fresh snapshots include server-side post-processing and translations arriving later.
 */
export function receiveHistory(viewerId: string, signal: AbortSignal, socketFactory = (url: string) => new WebSocket(url)):
Promise<{ korean: Caption[]; chinese: Caption[] }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new SchoolReadError("unavailable")); return; }
    const socket = socketFactory(`wss://learning.hanyang.ac.kr/translive-socket-server/?EIO=4&transport=websocket&translive_id=${schoolIdSchema.parse(viewerId)}`);
    let korean: Caption[] | null = null;
    let chinese: Caption[] | null = null;
    let done = false;
    let receivedBytes = 0;
    const finish = (error?: SchoolReadError) => {
      if (done) return;
      done = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      socket.close();
      if (error) reject(error);
      else resolve({ korean: korean!, chinese: chinese! });
    };
    const abort = () => finish(new SchoolReadError("unavailable"));
    const timer = setTimeout(() => finish(new SchoolReadError("timeout")), 10_000);
    signal.addEventListener("abort", abort, { once: true });
    socket.addEventListener("error", () => finish(new SchoolReadError("unavailable")));
    socket.addEventListener("close", () => { if (!done) finish(new SchoolReadError("unavailable")); });
    socket.addEventListener("message", ({ data }) => {
      if (done || typeof data !== "string") return;
      receivedBytes += Buffer.byteLength(data);
      if (receivedBytes > 8 * 1024 * 1024) { finish(new SchoolReadError("invalid")); return; }
      try {
        if (data.startsWith("0")) socket.send('40{"token":null,"vtoken":null,"ptoken":null}');
        else if (data === "2") socket.send("3");
        else if (data.startsWith("40")) socket.send('42["translation_socket_event_translate_caption_list",{"language_code":"zh-CN"}]');
        else if (data.startsWith("44")) finish(new SchoolReadError("permission"));
        else if (data.startsWith("42")) {
          const [event, payload] = JSON.parse(data.slice(2)) as [string, unknown];
          if (event === "stt_socket_event_caption_list") korean = z.array(captionSchema).max(20_000).parse(payload);
          if (event === "translate_socket_translate_caption_list_completed") {
            const translated = z.object({ language_code: z.literal("zh-CN"), captions: z.array(captionSchema).max(20_000) }).parse(payload);
            chinese = translated.captions;
          }
          if (event.includes("error")) finish(new SchoolReadError("unavailable"));
          if (korean !== null && chinese !== null) finish();
        }
      } catch { finish(new SchoolReadError("invalid")); }
    });
  });
}
