import { describe, expect, it, vi } from "vitest";
import { readSchoolCaptions, receiveHistory, SchoolCaptionBuffer } from "../src/lecture/school-reader.js";
import { createSchoolCaptionSync, chunkSchoolSegments } from "../src/lecture/school-sync.js";

const caption = (order: number, text: string, language = "ko", final = true) => ({
  order, text, language_code: language, speech_start_ms: order * 1000, speech_end_ms: order * 1000 + 500, is_final: final,
});

class Socket extends EventTarget {
  sent: string[] = [];
  close = vi.fn();
  send(value: string) { this.sent.push(value); }
  message(value: string) { this.dispatchEvent(new MessageEvent("message", { data: value })); }
}

describe("School caption viewer", () => {
  it("retains a viewer permission warning while waiting to retry", async () => {
    vi.useFakeTimers();
    const statuses: Array<{ error: string | null }> = [];
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/courses")) return new Response(JSON.stringify({ courses: [
        { courseId: "7", enabled: true, lastCheckedAt: null, sessionCount: 0, error: null },
      ] }));
      if (String(url).endsWith("/status")) { statuses.push(JSON.parse(String(init?.body))); return new Response('{"ok":true}'); }
      return new Response(JSON.stringify({ course_id: "7", learningx_module_item_id: "99", viewer_public: false,
        has_password: false, language_code: "ko", recording_status: "end", recording_start_time: null, recording_end_time: null }));
    }) as unknown as typeof globalThis.fetch;
    const sync = createSchoolCaptionSync({ baseUrl: "https://record.example", serviceToken: "synthetic", fetch,
      discover: async () => [{ courseId: "7", viewerId: "123", moduleItemId: "99", title: "Week" }] });
    try {
      sync.start(); await vi.advanceTimersByTimeAsync(31_000);
      expect(statuses.length).toBeGreaterThanOrEqual(3);
      expect(statuses.every(status => status.error?.includes("查看权限"))).toBe(true);
    } finally { sync.close(); vi.useRealTimers(); }
  });

  it("bounds storage batches by bytes as well as sentence count", () => {
    const segments = Array.from({ length: 100 }, (_, order) => ({ order, startedAtMs: order, endedAtMs: null,
      sourceText: "한".repeat(10_000), translatedText: "译".repeat(10_000), isFinal: true }));
    const chunks = chunkSchoolSegments(segments);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toHaveLength(100);
    expect(chunks.every(chunk => Buffer.byteLength(JSON.stringify(chunk)) < 1_600_000 && chunk.length <= 250)).toBe(true);
  });
  it("requests only existing history and keeps the complete beginning when joining mid-class", async () => {
    const socket = new Socket();
    const result = receiveHistory("7042679618", new AbortController().signal, () => socket as unknown as WebSocket);
    socket.message('0{"sid":"test"}'); socket.message("40{}"); socket.message("2");
    socket.message('42' + JSON.stringify(["stt_socket_event_caption_list", [caption(1, "first"), caption(200, "current")]]));
    socket.message('42' + JSON.stringify(["translate_socket_translate_caption_list_completed", {
      language_code: "zh-CN", captions: [caption(1, "开头", "zh-CN")],
    }]));
    expect((await result).korean.map(item => item.order)).toEqual([1, 200]);
    expect(socket.sent).toEqual(['40{"token":null,"vtoken":null,"ptoken":null}',
      '42["translation_socket_event_translate_caption_list",{"language_code":"zh-CN"}]', "3"]);
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("merges out-of-order history, partials, corrections and delayed Chinese without duplicates", () => {
    const buffer = new SchoolCaptionBuffer("123");
    buffer.apply("stt_socket_event_speech_recognized", caption(2, "partial", "ko", false));
    buffer.apply("stt_socket_event_caption_list", [caption(1, "old"), caption(1, "first")]);
    buffer.apply("stt_socket_event_speech_recognized", caption(2, "final"));
    buffer.apply("stt_socket_event_speech_recognized", caption(2, "stale partial", "ko", false));
    buffer.apply("stt_socket_event_speech_post_processed", { order: 1, correctedText: "corrected" });
    buffer.apply("translate_socket_translate_caption_list_completed", {
      translive_id: "123", language_code: "zh-CN", captions: [caption(1, "译文", "zh-CN")],
    });
    expect(buffer.segments()).toMatchObject([
      { order: 1, sourceText: "corrected", translatedText: "译文", isFinal: true },
      { order: 2, sourceText: "final", translatedText: "", isFinal: true },
    ]);
    expect(buffer.apply("translate_socket_translate_caption_completed", {
      translive_id: "999", language_code: "zh-CN", caption: caption(2, "other class", "zh-CN"),
    })).toBe(false);
  });

  it.each([
    { viewer_public: false }, { has_password: true }, { course_id: "other" }, { learningx_module_item_id: "wrong" },
  ])("never opens a socket across a viewer permission or course boundary: %j", async overrides => {
    const socket = vi.fn();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ course_id: "7", learningx_module_item_id: "99",
      viewer_public: true, has_password: false, language_code: "ko", recording_status: "recording",
      recording_start_time: "2026-09-08T01:00:00.000Z", recording_end_time: null, ...overrides,
    }))) as unknown as typeof globalThis.fetch;
    await expect(readSchoolCaptions({ courseId: "7", viewerId: "123", moduleItemId: "99", title: "Test" },
      new AbortController().signal, fetch, socket)).rejects.toThrow();
    expect(socket).not.toHaveBeenCalled();
  });
});
