import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAILY_COURSE } from "../shared/courses";
import type { ClassSession } from "./types";
import type { createRealtimeWebRtcTransport } from "./lib/realtimeWebRtc";

const rtc = vi.hoisted(() => ({
  options: null as Parameters<typeof createRealtimeWebRtcTransport>[0] | null,
  close: vi.fn(), send: vi.fn(() => true)
}));

// Keep the actual translation client, App handlers, queue, and HTTP deadline.
// Only the browser transport, microphone, and network response are synthetic.
vi.mock("./lib/realtimeWebRtc", async () => ({
  ...(await vi.importActual<typeof import("./lib/realtimeWebRtc")>("./lib/realtimeWebRtc")),
  createRealtimeWebRtcTransport: async (options: Parameters<typeof createRealtimeWebRtcTransport>[0]) => {
    rtc.options = options;
    const transport = { peerConnection: {} as RTCPeerConnection, dataChannel: {} as RTCDataChannel, sendEvent: rtc.send, close: rtc.close };
    options.onOpen(transport);
    return transport;
  }
}));

import App from "./App";

describe("default recording End with real flush and HTTP deadlines", () => {
  const track = { enabled: true, stop: vi.fn() };
  let stalled = false;
  let calls: Array<{ path: string; signal?: AbortSignal | null }>;

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    rtc.options = null;
    rtc.close.mockClear();
    rtc.send.mockClear();
    track.enabled = true;
    track.stop.mockClear();
    stalled = false;
    calls = [];
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({
      getTracks: () => [track], getAudioTracks: () => [track]
    }) } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "https://record.example").pathname;
      calls.push({ path, signal: init?.signal });
      // Deliberately ignore abort to verify requestJson's own Promise.race.
      if (stalled && path.startsWith("/api/sessions/")) return new Promise<Response>(() => undefined);
      if (path === "/api/courses") return json({ courses: [DAILY_COURSE], syncedAt: null, stale: false, source: "study" });
      if (path === "/api/school-captions") return json({ courses: [] });
      if (path === "/api/timetable") return json({ error: "no timetable in this fixture" }, 503);
      if (path === "/api/realtime/client-secret") return json({ clientSecret: "synthetic-test-secret", expiresAt: 1 });
      if (path === "/api/sessions" && init?.method === "POST") {
        return json({ session: session(), writerLease: { token: "synthetic-writer-token-000000000000000" } });
      }
      if (path === "/api/sessions") return json({ items: [], nextCursor: null, warnings: [] });
      throw new Error(`Unexpected fixture request: ${path}`);
    }));
  });

  afterEach(async () => {
    cleanup();
    await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function begin() {
    const view = render(<App />);
    await advance(0);
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await advance(0);
    expect(rtc.options).not.toBeNull();
    expect(screen.getByRole("button", { name: "暂停" })).toBeTruthy();
    act(() => rtc.options!.onMessage(JSON.stringify({ type: "session.output_transcript.delta", delta: "已接收的字幕" })));
    return view;
  }

  it.each([false, true])("settles absent session.closed and nonresponsive HTTP with unmounted=%s", async (unmounted) => {
    const view = await begin();
    stalled = true;
    fireEvent.click(screen.getByRole("button", { name: "结束" }));
    act(() => rtc.options!.onError("synthetic network failure during End"));
    expect((screen.getByRole("button", { name: "结束" }) as HTMLButtonElement).disabled).toBe(true);
    if (unmounted) view.unmount();

    await advance(5_100);
    expect(calls.some(call => call.path.endsWith("/fail"))).toBe(true);
    expect(track.stop).toHaveBeenCalledOnce();
    if (!unmounted) expect((screen.getByRole("button", { name: "结束" }) as HTMLButtonElement).disabled).toBe(true);
    // Five seconds flush + eight seconds failure-write + eight seconds readback.
    await advance(16_100);
    const writes = calls.filter(call => call.path.startsWith("/api/sessions/"));
    expect(writes).toHaveLength(2);
    expect(writes.every(call => call.signal?.aborted)).toBe(true);
    expect(calls.some(call => call.path.endsWith("/complete"))).toBe(false);
    if (!unmounted) {
      expect(screen.getByText("待恢复")).toBeTruthy();
      expect((screen.getByRole("button", { name: "继续" }) as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByRole("button", { name: "结束" }) as HTMLButtonElement).disabled).toBe(false);
      expect(document.querySelector(".subtitle-canvas")?.textContent).toContain("已接收的字幕");
    }
    await advance(30_000);
    expect(calls.filter(call => call.path.startsWith("/api/sessions/")).length).toBe(writes.length);
  });

  it("bounds resume waiting without overtaking or duplicating an unresolved failure write", async () => {
    await begin();
    stalled = true;
    act(() => rtc.options!.onError("synthetic disconnect"));
    await advance(0);
    expect(calls.filter(call => call.path.endsWith("/fail"))).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await advance(9_100);
    expect(screen.getByText("待恢复")).toBeTruthy();
    expect((screen.getByRole("button", { name: "继续" }) as HTMLButtonElement).disabled).toBe(false);
    expect(calls.some(call => call.path.endsWith("/resume"))).toBe(false);
    expect(document.querySelector(".subtitle-canvas")?.textContent).toContain("已接收的字幕");
    await advance(30_000);
    expect(calls.filter(call => call.path.endsWith("/fail"))).toHaveLength(1);
    expect(calls.filter(call => call.path.startsWith("/api/sessions/")).every(call => call.signal?.aborted)).toBe(true);
  });

  it("unlocks after the queue drain deadline while a timed-out heartbeat is still reconciling", async () => {
    await begin();
    stalled = true;
    await advance(4_000); // Begin the real periodic checkpoint.
    expect(calls.some(call => call.path.endsWith("/checkpoint"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "结束" }));
    act(() => rtc.options!.onMessage(JSON.stringify({ type: "session.closed" })));
    await advance(50);
    await advance(9_100);
    expect(screen.getByText("待恢复")).toBeTruthy();
    expect((screen.getByRole("button", { name: "继续" }) as HTMLButtonElement).disabled).toBe(false);
    expect(calls.some(call => call.path.endsWith("/complete"))).toBe(false);
    expect(document.querySelector(".subtitle-canvas")?.textContent).toContain("已接收的字幕");
    await advance(30_000);
    const requests = calls.filter(call => call.path.startsWith("/api/sessions/"));
    expect(requests.every(call => call.signal?.aborted)).toBe(true);
    expect(screen.getByText("待恢复")).toBeTruthy();
  });
});

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function session(): ClassSession {
  return {
    id: "lecture_deadline", title: "Synthetic", courseId: "daily", courseCode: "", courseName: "Daily",
    courseTerm: "", courseFolderName: "Daily", courseMatchStatus: "daily", finalizationWarning: null,
    revision: 0, status: "recording", startedAt: new Date().toISOString(), endedAt: null, durationMs: 0,
    sourceLanguage: "ko", targetLanguage: "zh", models: { translation: "gpt-realtime-translate", transcription: "gpt-realtime-whisper" },
    segments: [], segmentCount: 0, savedAt: null, updatedAt: new Date().toISOString()
  };
}
