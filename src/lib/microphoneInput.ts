export const MICROPHONE_BOOST_GAIN = 1;
export const MICROPHONE_AUTO_GAIN_MAX = 32;

const MICROPHONE_TARGET_RMS = 0.022;
const MICROPHONE_AUTO_GAIN_MIN_RMS = 0.00035;
const BOOST_PROCESSOR_BUFFER_SIZE = 4096;
const BOOST_ATTACK_SMOOTHING = 0.24;
const BOOST_RELEASE_SMOOTHING = 0.55;

const MICROPHONE_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: true
  }
};

export interface MicrophoneInput {
  stream: MediaStream;
  boostApplied: boolean;
  stop: () => void;
}

interface BoostGraph {
  audioContext: AudioContext;
  sourceNode: MediaStreamAudioSourceNode;
  boostNode: ScriptProcessorNode;
  limiterNode: DynamicsCompressorNode;
  destinationNode: MediaStreamAudioDestinationNode;
}

export async function createMicrophoneInput(audioBoostEnabled: boolean): Promise<MicrophoneInput> {
  const rawStream = await navigator.mediaDevices.getUserMedia(MICROPHONE_CONSTRAINTS);

  if (!audioBoostEnabled) {
    return createRawMicrophoneInput(rawStream);
  }

  try {
    return createBoostedMicrophoneInput(rawStream);
  } catch {
    return createRawMicrophoneInput(rawStream);
  }
}

function createRawMicrophoneInput(rawStream: MediaStream): MicrophoneInput {
  return {
    stream: rawStream,
    boostApplied: false,
    stop: () => stopStream(rawStream)
  };
}

function createBoostedMicrophoneInput(rawStream: MediaStream): MicrophoneInput {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioContextCtor();
  let graph: BoostGraph;
  try {
    graph = createBoostGraph(audioContext, rawStream);
  } catch (error) {
    audioContext.close().catch(() => undefined);
    throw error;
  }

  graph.audioContext.resume().catch(() => undefined);

  return {
    stream: graph.destinationNode.stream,
    boostApplied: true,
    stop: () => {
      stopStream(graph.destinationNode.stream);
      stopStream(rawStream);
      disconnectGraph(graph);
      graph.audioContext.close().catch(() => undefined);
    }
  };
}

function createBoostGraph(audioContext: AudioContext, rawStream: MediaStream): BoostGraph {
  const sourceNode = audioContext.createMediaStreamSource(rawStream);
  const boostNode = audioContext.createScriptProcessor(BOOST_PROCESSOR_BUFFER_SIZE, 1, 1);
  const limiterNode = audioContext.createDynamicsCompressor();
  const destinationNode = audioContext.createMediaStreamDestination();
  let adaptiveGain = MICROPHONE_BOOST_GAIN;

  limiterNode.threshold.value = -10;
  limiterNode.knee.value = 18;
  limiterNode.ratio.value = 12;
  limiterNode.attack.value = 0.003;
  limiterNode.release.value = 0.25;

  boostNode.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);
    const rms = calculateRms(input);
    const targetGain =
      rms >= MICROPHONE_AUTO_GAIN_MIN_RMS
        ? clamp(MICROPHONE_TARGET_RMS / rms, MICROPHONE_BOOST_GAIN, MICROPHONE_AUTO_GAIN_MAX)
        : MICROPHONE_BOOST_GAIN;
    const smoothing = targetGain > adaptiveGain ? BOOST_ATTACK_SMOOTHING : BOOST_RELEASE_SMOOTHING;
    adaptiveGain += (targetGain - adaptiveGain) * smoothing;

    for (let index = 0; index < input.length; index += 1) {
      output[index] = softLimit(input[index] * adaptiveGain);
    }
  };

  sourceNode.connect(boostNode);
  boostNode.connect(limiterNode);
  limiterNode.connect(destinationNode);

  return { audioContext, sourceNode, boostNode, limiterNode, destinationNode };
}

function disconnectGraph(graph: BoostGraph): void {
  graph.sourceNode.disconnect();
  graph.boostNode.onaudioprocess = null;
  graph.boostNode.disconnect();
  graph.limiterNode.disconnect();
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function softLimit(value: number): number {
  return Math.tanh(value);
}

function stopStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop());
}
