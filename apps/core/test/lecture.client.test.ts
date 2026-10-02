import { describe, expect, it, vi } from "vitest";

import { LectureClient } from "../src/lecture/index.js";

const SERVICE_TOKEN = "lecture-service-token-for-tests-1234";
const SITE_AUTH_TOKEN = "sites-bypass-token-for-tests-123456";

function summary() {
  return {
    id: "session-1",
    title: "Week 1",
    courseId: "7",
    courseCode: "ACC-7",
    courseName: "Accounting",
    courseTerm: "2026 Fall",
    courseFolderName: "ACC-7 - Accounting",
    courseMatchStatus: "matched",
    finalizationWarning: "The final sentence may be incomplete.",
    revision: 4,
    status: "ready",
    startedAt: "2026-09-01T10:00:00.000Z",
    endedAt: "2026-09-01T11:00:00.000Z",
    durationMs: 3_600_000,
    sourceLanguage: "ko",
    targetLanguage: "zh",
    models: {
      translation: "gpt-realtime-translate",
      transcription: "gpt-realtime-whisper",
      mode: "realtime-translate",
    },
    segmentCount: 1,
    savedAt: "2026-09-01T11:00:01.000Z",
    updatedAt: "2026-09-01T11:00:01.000Z",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("LectureClient", () => {
  it("preserves daily/date/cursor filters and historical model names in the shared read contract", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("course_id")).toBe("daily");
      expect(url.searchParams.get("start_at")).toBe("2026-08-01T00:00:00Z");
      expect(url.searchParams.get("end_at")).toBe("2026-09-01T00:00:00Z");
      expect(url.searchParams.get("cursor")).toBe("opaque-cursor");
      return json({ items: [{ ...summary(), courseId: "daily", courseMatchStatus: "daily",
        models: { translation: "retired-translation-model", transcription: "gpt-4o-mini-transcribe", mode: "historical-mode" } }],
        nextCursor: "next-page", warnings: [] });
    }) as typeof globalThis.fetch;
    const client = new LectureClient({ baseUrl: "http://lecture:8091", serviceToken: SERVICE_TOKEN, fetch });
    const page = await client.listSessions({ courseId: "daily", startAt: "2026-08-01T00:00:00Z", endAt: "2026-09-01T00:00:00Z", cursor: "opaque-cursor" });
    expect(page.nextCursor).toBe("next-page");
    expect(page.items[0]?.models.transcription).toBe("gpt-4o-mini-transcribe");
  });

  it("uses fixed internal GET paths, service authentication, and the paged contract for every read", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("http://lecture:8091");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${SERVICE_TOKEN}`);
      expect(new Headers(init?.headers).get("oai-sites-authorization")).toBe(`Bearer ${SITE_AUTH_TOKEN}`);
      expect(new Headers(init?.headers).get("x-study-lecture-contract")).toBe("paged-v1");
      if (url.pathname.endsWith("/search")) {
        expect(url.searchParams.get("q")).toBe("homework");
        expect(url.searchParams.get("course_id")).toBe("7");
        return json({
          query: "homework",
          nextCursor: null, warnings: [],
          items: [{
            sessionId: "session-1",
            sessionTitle: "Week 1",
            sessionStatus: "ready",
            finalizationWarning: "The final sentence may be incomplete.",
            sessionStartedAt: "2026-09-01T10:00:00.000Z",
            courseId: "7",
            courseCode: "ACC-7",
            courseName: "Accounting",
            segmentId: "segment-1",
            startedAtMs: 1_000,
            endedAtMs: 2_000,
            sourceText: "homework source",
            translatedText: "homework translation",
          }],
        });
      }
      if (url.pathname.endsWith("/sessions/session-1")) {
        return json({
          session: summary(),
          nextCursor: null, warnings: [], rangeComplete: true,
          items: [
              {
                id: "segment-1",
                commitSequence: 3,
                startedAtMs: 1_000,
                endedAtMs: 2_000,
                sourceText: "원문",
                translatedText: "译文",
                isFinal: true,
                createdAt: "2026-09-01T10:00:01.000Z",
                updatedAt: "2026-09-01T10:00:02.000Z",
              },
            ],
        });
      }
      expect(url.pathname).toBe("/internal/mcp/lecture/sessions");
      expect(url.searchParams.get("status")).toBe("ready");
      return json({ items: [summary()], nextCursor: null, warnings: [] });
    }) as unknown as typeof globalThis.fetch;
    const client = new LectureClient({
      baseUrl: "http://lecture:8091",
      serviceToken: SERVICE_TOKEN,
      siteAuthToken: SITE_AUTH_TOKEN,
      fetch,
    });

    expect((await client.listSessions({ status: "ready" })).items[0]).toMatchObject({
      finalizationWarning: "The final sentence may be incomplete.",
      revision: 4,
    });
    expect((await client.getSession("session-1")).items[0]).toMatchObject({
      commitSequence: 3,
      sourceText: "원문",
      translatedText: "译文",
    });
    await expect(client.search({ query: "homework", courseId: "7" })).resolves.toMatchObject({
      query: "homework",
      items: [{
        finalizationWarning: "The final sentence may be incomplete.",
      }],
    });
  });

  it("maps upstream failures to a safe error without returning the response body", async () => {
    const fetch = vi.fn(async () => json({ error: "sensitive internal detail" }, 503)) as unknown as typeof globalThis.fetch;
    const client = new LectureClient({
      baseUrl: "http://lecture:8091",
      serviceToken: SERVICE_TOKEN,
      fetch,
    });

    await expect(client.listSessions()).rejects.toMatchObject({
      code: "upstream_error",
      status: 503,
      message: "The Lecture service rejected the request.",
    });
  });

  it("accepts the producer's maximum course, segment identifier, and text lengths", async () => {
    const producerMaximumCourseId = "1".repeat(160);
    const producerMaximumId = "s".repeat(160);
    const producerMaximumText = "x".repeat(40_000);
    const segment = {
      id: producerMaximumId,
      commitSequence: 0,
      startedAtMs: 0,
      sourceText: producerMaximumText,
      translatedText: producerMaximumText,
      isFinal: true,
      createdAt: "2026-09-01T10:00:01.000Z",
      updatedAt: "2026-09-01T10:00:02.000Z",
    };
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/search")) {
        expect(url.searchParams.get("course_id")).toBe(producerMaximumCourseId);
        return json({
          query: "x",
          nextCursor: null, warnings: [],
          items: [{
            sessionId: "session-1",
            sessionTitle: "Week 1",
            sessionStatus: "ready",
            finalizationWarning: null,
            sessionStartedAt: "2026-09-01T10:00:00.000Z",
            courseId: producerMaximumCourseId,
            courseCode: "ACC-7",
            courseName: "Accounting",
            segmentId: producerMaximumId,
            startedAtMs: 0,
            sourceText: producerMaximumText,
            translatedText: producerMaximumText,
          }],
        });
      }
      return json({
        session: {
          ...summary(),
          courseId: producerMaximumCourseId,
        },
        items: [segment], nextCursor: null, warnings: [], rangeComplete: true,
      });
    }) as unknown as typeof globalThis.fetch;
    const client = new LectureClient({
      baseUrl: "http://lecture:8091",
      serviceToken: SERVICE_TOKEN,
      fetch,
    });

    await expect(client.getSession("session-1")).resolves.toMatchObject({
      session: {
        courseId: producerMaximumCourseId,
      },
      items: [{
          id: producerMaximumId,
          sourceText: producerMaximumText,
          translatedText: producerMaximumText,
        }],
    });
    await expect(client.search({
      query: "x",
      courseId: producerMaximumCourseId,
    })).resolves.toMatchObject({
      items: [{
        courseId: producerMaximumCourseId,
        segmentId: producerMaximumId,
        sourceText: producerMaximumText,
        translatedText: producerMaximumText,
      }],
    });
  });

  it("aborts an unbounded response before buffering more than the configured limit", async () => {
    const chunk = new Uint8Array(1_100_000);
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    }))) as unknown as typeof globalThis.fetch;
    const client = new LectureClient({
      baseUrl: "http://lecture:8091",
      serviceToken: SERVICE_TOKEN,
      fetch,
    });

    await expect(client.listSessions()).rejects.toMatchObject({
      code: "invalid_response",
      message: "The Lecture response was too large.",
    });
  });

  it("keeps the timeout active while the response body is streaming", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(
      new ReadableStream({
        start(controller) {
          const timer = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode('{"sessions":[]}'));
            controller.close();
          }, 200);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            controller.error(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        },
      }),
    )) as unknown as typeof globalThis.fetch;
    const client = new LectureClient({
      baseUrl: "http://lecture:8091",
      serviceToken: SERVICE_TOKEN,
      fetch,
      timeoutMs: 20,
    });

    await expect(client.listSessions()).rejects.toMatchObject({ code: "timeout" });
  });
});
