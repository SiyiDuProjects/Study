import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMicrophoneInput, MICROPHONE_BOOST_GAIN } from "./microphoneInput";

let rawStop: ReturnType<typeof vi.fn>;
let boostedStop: ReturnType<typeof vi.fn>;
let rawStream: MediaStream;
let boostedStream: MediaStream;
let latestContext: FakeAudioContext | null;
let originalMediaDevices: Navigator["mediaDevices"] | undefined;
let originalAudioContext: typeof AudioContext | undefined;
let sourceNode: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
let gainNode: { gain: { value: number }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
let limiterNode: {
  threshold: { value: number };
  knee: { value: number };
  ratio: { value: number };
  attack: { value: number };
  release: { value: number };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

class FakeAudioContext {
  resume = vi.fn(() => Promise.resolve());
  close = vi.fn(() => Promise.resolve());

  constructor() {
    latestContext = this;
  }

  createMediaStreamSource() {
    sourceNode = { connect: vi.fn(), disconnect: vi.fn() };
    return sourceNode as unknown as MediaStreamAudioSourceNode;
  }

  createGain() {
    gainNode = { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
    return gainNode as unknown as GainNode;
  }

  createDynamicsCompressor() {
    limiterNode = {
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn()
    };
    return limiterNode as unknown as DynamicsCompressorNode;
  }

  createMediaStreamDestination() {
    return { stream: boostedStream } as unknown as MediaStreamAudioDestinationNode;
  }
}

describe("createMicrophoneInput", () => {
  beforeEach(() => {
    rawStop = vi.fn();
    boostedStop = vi.fn();
    latestContext = null;
    rawStream = createStream(rawStop);
    boostedStream = createStream(boostedStop);
    originalMediaDevices = navigator.mediaDevices;
    originalAudioContext = window.AudioContext;

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue(rawStream)
      }
    });
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: FakeAudioContext
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices
    });
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: originalAudioContext
    });
  });

  it("returns the raw microphone stream when boost is disabled", async () => {
    const input = await createMicrophoneInput(false);

    expect(input.stream).toBe(rawStream);
    expect(input.boostApplied).toBe(false);

    input.stop();
    expect(rawStop).toHaveBeenCalledTimes(1);
  });

  it("routes microphone audio through gain and limiter when boost is enabled", async () => {
    const input = await createMicrophoneInput(true);

    expect(input.stream).toBe(boostedStream);
    expect(input.boostApplied).toBe(true);
    expect(gainNode.gain.value).toBe(MICROPHONE_BOOST_GAIN);
    expect(limiterNode.threshold.value).toBe(-10);
    expect(limiterNode.ratio.value).toBe(12);
    expect(sourceNode.connect).toHaveBeenCalledWith(gainNode);
    expect(gainNode.connect).toHaveBeenCalledWith(limiterNode);
    expect(latestContext?.resume).toHaveBeenCalled();

    input.stop();
    expect(boostedStop).toHaveBeenCalledTimes(1);
    expect(rawStop).toHaveBeenCalledTimes(1);
    expect(latestContext?.close).toHaveBeenCalled();
  });
});

function createStream(stop: ReturnType<typeof vi.fn>): MediaStream {
  return {
    getTracks: vi.fn(() => [{ stop }]),
    getAudioTracks: vi.fn(() => [{ stop, enabled: true }])
  } as unknown as MediaStream;
}
