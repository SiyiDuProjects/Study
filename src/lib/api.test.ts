import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, BROWSER_API_TIMEOUT_MS, fetchCourses } from "./api";

describe("browser API timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts a hanging request at a bounded deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchCourses();
    const rejected = expect(request).rejects.toMatchObject({
      status: 408,
      code: "client_timeout"
    } satisfies Partial<ApiRequestError>);
    await vi.advanceTimersByTimeAsync(BROWSER_API_TIMEOUT_MS);
    await rejected;
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
