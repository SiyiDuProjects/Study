import { createHash } from "node:crypto";
import { readBoundedText, type LectureClientOptions } from "./client.js";
import { schoolCoursesSchema } from "./school-types.js";
import { readSchoolCaptions, watchSchoolCaptions, SchoolReadError, type SchoolViewer } from "./school-reader.js";
import type { SchoolImport } from "./school-types.js";
import { log } from "../logger.js";

export function createSchoolCaptionSync(options: LectureClientOptions & {
  discover: (courseId: string) => Promise<SchoolViewer[]>;
}) {
  const controller = new AbortController();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const discoveries = new Map<string, { checkedAt: number; viewers: SchoolViewer[] }>();
  const snapshots = new Map<string, { signature: string; nextRead: number }>();
  const streams = new Map<string, AbortController>();
  const savedSegments = new Map<string, Map<number, string>>();
  const streamErrors = new Map<string, string>();
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;

  async function request(path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bearer ${options.serviceToken}` };
    if (options.siteAuthToken) headers["OAI-Sites-Authorization"] = `Bearer ${options.siteAuthToken}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetchImpl(new URL(`/internal/school-captions/${path}`, options.baseUrl), {
      method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) throw new Error("School caption storage unavailable");
    return JSON.parse(await readBoundedText(response, 256 * 1024));
  }

  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const { courses } = schoolCoursesSchema.parse(await request("courses"));
      const enabled = courses.filter(course => course.enabled);
      for (const id of discoveries.keys()) if (!enabled.some(course => course.courseId === id)) discoveries.delete(id);
      const allowedViewers = new Set([...discoveries.values()].flatMap(discovery => discovery.viewers.map(viewer => viewer.viewerId)));
      for (const [id, stream] of streams) if (!allowedViewers.has(id)) { stream.abort(); streams.delete(id); }
      for (const course of enabled) {
        if (stopped) break;
        let count = course.sessionCount;
        let error: string | null = null;
        try {
          let discovery = discoveries.get(course.courseId);
          if (!discovery || Date.now() - discovery.checkedAt > 5 * 60_000) {
            discovery = { checkedAt: Date.now(), viewers: await options.discover(course.courseId) };
            discoveries.set(course.courseId, discovery);
          }
          count = discovery.viewers.length;
          for (const viewer of discovery.viewers) {
            if (stopped) break;
            if (streamErrors.has(viewer.viewerId)) error = streamErrors.get(viewer.viewerId)!;
            if (streams.has(viewer.viewerId)) continue;
            const previous = snapshots.get(viewer.viewerId);
            if (previous && Date.now() < previous.nextRead) continue;
            try {
              const snapshot = await readSchoolCaptions(viewer, controller.signal, fetchImpl);
              streamErrors.delete(viewer.viewerId);
              if (!snapshot) { snapshots.set(viewer.viewerId, { signature: "", nextRead: Date.now() + 60_000 }); continue; }
              const signature = await persist(snapshot);
              streamErrors.delete(viewer.viewerId);
              snapshots.set(viewer.viewerId, { signature, nextRead: Date.now() + (snapshot.endedAt ? 5 * 60_000 : 10_000) });
              if (!snapshot.endedAt) {
                const stream = new AbortController(); streams.set(viewer.viewerId, stream);
                void watchSchoolCaptions(snapshot, AbortSignal.any([controller.signal, stream.signal]), async updated => {
                  const signature = await persist(updated);
                  snapshots.set(viewer.viewerId, { signature, nextRead: Date.now() + 15_000 });
                }, fetchImpl).catch(() => {
                  streamErrors.set(viewer.viewerId, "学校字幕流暂时中断，后台会补齐历史并重连。");
                  snapshots.set(viewer.viewerId, { signature: snapshots.get(viewer.viewerId)?.signature ?? "", nextRead: Date.now() + 15_000 });
                }).finally(() => { if (streams.get(viewer.viewerId) === stream) streams.delete(viewer.viewerId); });
              }
            } catch (failure) {
              error = failure instanceof SchoolReadError && failure.code === "permission"
                ? "部分学校转录需要额外查看权限，尚未同步。" : "部分学校字幕暂时无法读取，后台会自动重试。";
              streamErrors.set(viewer.viewerId, error);
              // Keep the last successful signature; a failed read must never replace stored subtitles.
              snapshots.set(viewer.viewerId, { signature: previous?.signature ?? "", nextRead: Date.now() + 60_000 });
            }
          }
        } catch { error = "Weekly Learning 暂时无法读取，后台会自动重试。"; }
        if (!stopped) await request("status", { courseId: course.courseId, sessionCount: count, error });
      }
      // Bound transient state to the current enabled-course discoveries.
      const known = new Set([...discoveries.values()].flatMap(discovery => discovery.viewers.map(viewer => viewer.viewerId)));
      for (const id of snapshots.keys()) if (!known.has(id)) snapshots.delete(id);
      for (const id of savedSegments.keys()) if (!known.has(id)) savedSegments.delete(id);
      for (const id of streamErrors.keys()) if (!known.has(id)) streamErrors.delete(id);
    } catch {
      if (!stopped) log("warn", "school_caption_sync_unavailable", {});
    } finally {
      running = false;
      if (!stopped) { timer = setTimeout(() => void tick(), 15_000); timer.unref(); }
    }
  }

  async function persist(snapshot: SchoolImport): Promise<string> {
    const signature = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    if (signature === snapshots.get(snapshot.viewerId)?.signature) return signature;
    const saved = savedSegments.get(snapshot.viewerId) ?? new Map<number, string>();
    const changed = snapshot.segments.filter(segment => saved.get(segment.order) !== JSON.stringify(segment));
    for (const segments of chunkSchoolSegments(changed)) await request("import", { ...snapshot, segments });
    for (const segment of changed) saved.set(segment.order, JSON.stringify(segment));
    savedSegments.set(snapshot.viewerId, saved);
    return signature;
  }
  return {
    start() { if (!timer && !running && !stopped) void tick(); },
    close() { stopped = true; if (timer) clearTimeout(timer); controller.abort(); },
  };
}

export function chunkSchoolSegments(segments: SchoolImport["segments"]): SchoolImport["segments"][] {
  const chunks: SchoolImport["segments"][] = [];
  let current: SchoolImport["segments"] = [];
  let bytes = 0;
  for (const segment of segments) {
    const size = Buffer.byteLength(JSON.stringify(segment));
    if (current.length && (current.length === 250 || bytes + size > 1_500_000)) { chunks.push(current); current = []; bytes = 0; }
    current.push(segment); bytes += size;
  }
  if (current.length || chunks.length === 0) chunks.push(current);
  return chunks;
}
