import type { RealtimeClientDiagnostic } from "../types";

const LEVEL_INTERVAL_MS = 500;

export interface MicrophoneLevelMonitor {
  stop: () => void;
}

export function startMicrophoneLevelMonitor(
  stream: MediaStream,
  onDiagnostic?: (event: RealtimeClientDiagnostic) => void
): MicrophoneLevelMonitor | null {
  if (!onDiagnostic) {
    return null;
  }

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioContextCtor();
  const sourceNode = audioContext.createMediaStreamSource(stream);
  const analyserNode = audioContext.createAnalyser();
  const samples = new Float32Array(analyserNode.fftSize);
  let interval: number | null = null;

  analyserNode.fftSize = 2048;
  sourceNode.connect(analyserNode);
  audioContext.resume().catch(() => undefined);

  interval = window.setInterval(() => {
    analyserNode.getFloatTimeDomainData(samples);
    onDiagnostic({
      kind: "microphone",
      level: calculateRms(samples),
      at: Date.now()
    });
  }, LEVEL_INTERVAL_MS);

  return {
    stop: () => {
      if (interval) {
        window.clearInterval(interval);
        interval = null;
      }
      analyserNode.disconnect();
      sourceNode.disconnect();
      audioContext.close().catch(() => undefined);
    }
  };
}

function calculateRms(input: ArrayLike<number>): number {
  if (input.length === 0) {
    return 0;
  }

  let sum = 0;
  for (let index = 0; index < input.length; index += 1) {
    const sample = input[index];
    sum += sample * sample;
  }
  return Math.sqrt(sum / input.length);
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
