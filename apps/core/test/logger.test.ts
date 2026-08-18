import { describe, expect, it, vi } from "vitest";
import { log } from "../src/logger.js";

describe("logger", () => {
  it("redacts credential-like fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    log("info", "test", {
      authorization: "Bearer abc",
      nested: { canvasPat: "secret", safe: "ok" },
    });
    const output = String(spy.mock.calls[0]?.[0]);
    expect(output).not.toContain("Bearer abc");
    expect(output).not.toContain("secret");
    expect(output).toContain("[redacted]");
    expect(output).toContain("ok");
    spy.mockRestore();
  });
});
