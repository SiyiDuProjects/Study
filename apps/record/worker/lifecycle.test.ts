// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getLectureSessionResponseSchema } from "../../core/src/lecture/types";
import { handleRequest, type SitesEnv } from "./index";
import { createTestD1 } from "./test-d1";

const at = "2026-09-01T00:00:00.000Z";
function setup() {
  const env = { DB: createTestD1(), STUDY_OWNER_EMAIL: "owner@example.com" } as SitesEnv;
  return async (path: string, method = "GET", body?: unknown) => handleRequest(new Request(`https://record.example/api/${path}`, {
    method,
    headers: { "oai-authenticated-user-id": "owner", "oai-authenticated-user-email": "owner@example.com",
      Origin: "https://record.example", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
}
const input = { courseId: "daily", startedAt: at, models: { translation: "gpt-realtime-translate", transcription: "gpt-realtime-whisper" } };
const segment = (id: string, commitSequence: number) => ({ id, commitSequence, startedAtMs: commitSequence * 1000,
  sourceText: "원문", translatedText: "译文", isFinal: true, createdAt: at, updatedAt: at });

describe("recording lifecycle on the production Worker route", () => {
  it("persists delta checkpoints and empty finalization without losing prior segments", async () => {
    const request = setup();
    const response = await request("sessions", "POST", input);
    expect(response.status).toBe(201);
    const created = await response.json() as { session: { id: string }; writerLease: { token: string } };
    const path = `sessions/${created.session.id}`;
    const writerLeaseToken = created.writerLease.token;
    expect((await request("sessions", "POST", input)).status).toBe(409);
    const base = { writerLeaseToken, durationMs: 3000 };
    expect((await request(`${path}/checkpoint`, "POST", { ...base, expectedRevision: 0, segments: [segment("second", 1)] })).status).toBe(200);
    const stale = await request(`${path}/checkpoint`, "POST", { ...base, expectedRevision: 0, segments: [segment("bad", 2)] });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "writer_lease_conflict", currentRevision: 1 });
    const passive = getLectureSessionResponseSchema.parse(await (await request(path)).json());
    expect(passive.session.revision).toBe(1);
    expect(passive.items.map(item => item.id)).toEqual(["second"]);
    expect((await request(`${path}/checkpoint`, "POST", { ...base, expectedRevision: 1, segments: [segment("first", 0)] })).status).toBe(200);
    expect((await request(`${path}/complete`, "POST", { ...base, expectedRevision: 2, endedAt: at, segments: [] })).status).toBe(200);
    const page = getLectureSessionResponseSchema.parse(await (await request(path)).json());
    expect(page.session).toMatchObject({ status: "ready", revision: 3 });
    expect(page.items.map(item => item.id)).toEqual(["first", "second"]);
    const closedWrite = await request(`${path}/checkpoint`, "POST", { ...base, expectedRevision: 3, segments: [] });
    expect(closedWrite.status).toBe(409);
    expect(await closedWrite.json()).toEqual({ error: "Lecture session is no longer writable", code: "session_not_writable" });
  });

  it("requires revision-bound takeover and preserves finalization warnings", async () => {
    const request = setup();
    const created = await (await request("sessions", "POST", input)).json() as { session: { id: string }; writerLease: { token: string } };
    const path = `sessions/${created.session.id}`;
    const oldToken = created.writerLease.token;
    expect((await request(path, "DELETE")).status).toBe(409);
    expect((await request(`${path}/resume`, "POST", { takeover: true })).status).toBe(400);
    const takeover = await request(`${path}/resume`, "POST", { takeover: true, expectedRevision: 0 });
    expect(takeover.status).toBe(200);
    const taken = await takeover.json() as { session: { finalizationWarning: string; revision: number }; writerLease: { token: string } };
    expect(taken.session.finalizationWarning).toBeTruthy();
    expect(taken.writerLease.token).not.toBe(oldToken);
    expect((await request(`${path}/checkpoint`, "POST", { writerLeaseToken: oldToken, expectedRevision: 0, segments: [], durationMs: 0 })).status).toBe(409);
    const base = { writerLeaseToken: taken.writerLease.token, expectedRevision: 1, segments: [segment("saved", 0)], durationMs: 1000 };
    const failed = await request(`${path}/fail`, "POST", { ...base, finalizationWarning: "tail missing" });
    expect(failed.status).toBe(200);
    expect((await request(path, "DELETE")).status).toBe(409);
    expect((await request(`${path}/complete`, "POST", { ...base, expectedRevision: 2, endedAt: at })).status).toBe(409);
    expect((await request(`${path}/complete`, "POST", { ...base, expectedRevision: 2, endedAt: at, acceptIncomplete: true })).status).toBe(200);
    const read = getLectureSessionResponseSchema.parse(await (await request(path)).json());
    expect(read.session.finalizationWarning).toBe(taken.session.finalizationWarning);
    expect((await request(path, "DELETE")).status).toBe(204);
    expect(getLectureSessionResponseSchema.parse(await (await request(path)).json()).session.status).toBe("archived");
  });

  it("keeps writer model choices strict and rejects client-owned metadata or raw audio", async () => {
    const request = setup();
    expect((await request("sessions", "POST", { ...input, courseName: "invented" })).status).toBe(400);
    expect((await request("sessions", "POST", { ...input, audio: "not permitted" })).status).toBe(400);
    expect((await request("sessions", "POST", { ...input, models: { ...input.models, transcription: "historical-only-model" } })).status).toBe(400);
  });
});
