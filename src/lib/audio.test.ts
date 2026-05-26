import { describe, expect, it } from "vitest";
import { floatToPcm16, pcm16ToBase64, resampleTo24k, SAMPLES_PER_FRAME } from "./audio";

describe("audio helpers", () => {
  it("resamples 48k mono input to 24k", () => {
    const input = new Float32Array(48_000);
    const output = resampleTo24k(input, 48_000);

    expect(output.length).toBe(24_000);
  });

  it("converts float audio to pcm16", () => {
    const output = floatToPcm16(new Float32Array([-1, 0, 1]));

    expect(Array.from(output)).toEqual([-32768, 0, 32767]);
  });

  it("encodes pcm16 as base64", () => {
    const encoded = pcm16ToBase64(new Int16Array([0, 32767]));

    expect(encoded.length).toBeGreaterThan(0);
  });

  it("uses 200ms frames at 24k", () => {
    expect(SAMPLES_PER_FRAME).toBe(4800);
  });
});
