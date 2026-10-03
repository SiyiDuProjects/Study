// Cross-runtime integration: keep browser and Worker ambient types out of each other's production TypeScript projects. Vitest executes both against synthetic transport.
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DAILY_COURSE } from "../shared/courses";
import type { RealtimeClientCallbacks } from "../src/types";

const transport = vi.hoisted(() => ({ clients: [] as { callbacks: RealtimeClientCallbacks; stops: number }[] }));
vi.mock("../src/lib/realtimeTranslation", () => ({ RealtimeTranslationClient: class {
  entry: { callbacks: RealtimeClientCallbacks; stops: number };
  constructor(_secret: unknown, callbacks: RealtimeClientCallbacks) {
    this.entry = { callbacks, stops: 0 };
    transport.clients.push(this.entry);
  }
  async start() { this.entry.callbacks.onOpen(); }
  pause() {}
  resume() {}
  async stopAndFlush() { this.entry.stops += 1; }
} }));
vi.mock("../src/lib/api", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api")),
  fetchCourses: async () => ({ courses: [DAILY_COURSE], syncedAt: null, stale: false, source: "study" }),
  fetchTimetable: async () => null,
  fetchSchoolCourses: async () => []
}));
import App from "../src/App";
import { handleRequest, type SitesEnv } from "../worker/index";
import { createTestD1 } from "../worker/test-d1";
import { getRemoteSession, resumeRemoteSession } from "../src/lib/api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([false, true])("serializes a delayed failure before resume with another writer taking over=%s", async (anotherWriter) => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  transport.clients = [];
  const env = { DB: createTestD1(), STUDY_OWNER_EMAIL: "owner@example.com" } as SitesEnv;
  let releaseFailure!: () => void;
  const failureGate = new Promise<void>(resolve => { releaseFailure = resolve; });
  let failureStarted = false;
  let resumeStarted = false;
  let sessionId = "";
  const writes: { action: string; status: number; revision: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://record.example");
    if (!url.pathname.startsWith("/api/sessions")) throw new Error("Unexpected external request");
    if (url.pathname.endsWith("/resume")) resumeStarted = true;
    if (url.pathname.endsWith("/fail")) { failureStarted = true; await failureGate; }
    const headers = new Headers(init?.headers);
    headers.set("oai-authenticated-user-id", "owner");
    headers.set("oai-authenticated-user-email", "owner@example.com");
    headers.set("Origin", "https://record.example");
    const response = await handleRequest(new Request(url, { ...init, headers }), env);
    if (init?.body) writes.push({ action: url.pathname.split("/").at(-1)!, status: response.status, revision: JSON.parse(String(init.body)).expectedRevision });
    if (url.pathname === "/api/sessions" && init?.method === "POST") sessionId = (await response.clone().json() as { session: { id: string } }).session.id;
    return response;
  }));
  render(createElement(App));
  await waitFor(() => expect((screen.getByRole("button", { name: "开始" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "开始" }));
  await waitFor(() => expect(transport.clients).toHaveLength(1));
  act(() => transport.clients[0].callbacks.onSegment?.({ translatedText: "断网前字幕", sourceText: "", elapsedMs: 100 }));
  act(() => transport.clients[0].callbacks.onError("Synthetic disconnect"));
  await waitFor(() => expect(failureStarted).toBe(true));
  if (anotherWriter) {
    await resumeRemoteSession(sessionId, { takeover: true, expectedRevision: 0 });
    resumeStarted = false;
  }
  fireEvent.click(screen.getByRole("button", { name: "继续" }));
  await act(async () => { await Promise.resolve(); });
  const resumedBeforeFailure = resumeStarted;
  await act(async () => { releaseFailure(); });
  if (anotherWriter) {
    await screen.findByText(/这条记录已被另一台设备或页面接管/);
    expect(resumedBeforeFailure).toBe(false);
    expect(transport.clients).toHaveLength(1);
    expect(writes.filter(write => write.action === "fail")).toEqual([{ action: "fail", status: 409, revision: 0 }]);
    expect(writes.filter(write => write.action === "resume")).toHaveLength(1);
    expect(document.querySelector(".subtitle-canvas")?.textContent).toContain("断网前字幕");
    return;
  }
  await waitFor(() => expect(transport.clients).toHaveLength(2));
  expect(resumedBeforeFailure).toBe(false);
  expect(writes.filter(write => ["fail", "resume"].includes(write.action))).toEqual([
    { action: "fail", status: 200, revision: 0 },
    { action: "resume", status: 200, revision: 1 }
  ]);
  act(() => transport.clients[1].callbacks.onSegment?.({ translatedText: "新连接字幕", sourceText: "", elapsedMs: 200 }));
  fireEvent.click(screen.getByRole("button", { name: "暂停" }));
  await waitFor(() => expect(writes.some(write => write.action === "checkpoint" && write.status === 200)).toBe(true));
  const stored = await getRemoteSession(sessionId);
  expect(stored.segments.map(segment => segment.translatedText)).toEqual(["断网前字幕", "新连接字幕"]);
  expect(transport.clients[1].stops).toBe(0);
  expect(document.body.textContent).not.toContain("这条记录已被另一台设备或页面接管");
});
