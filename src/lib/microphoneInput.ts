export const MICROPHONE_BOOST_GAIN = 24;

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
  gainNode: GainNode;
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
  const gainNode = audioContext.createGain();
  const limiterNode = audioContext.createDynamicsCompressor();
  const destinationNode = audioContext.createMediaStreamDestination();

  gainNode.gain.value = MICROPHONE_BOOST_GAIN;
  limiterNode.threshold.value = -10;
  limiterNode.knee.value = 18;
  limiterNode.ratio.value = 12;
  limiterNode.attack.value = 0.003;
  limiterNode.release.value = 0.25;

  sourceNode.connect(gainNode);
  gainNode.connect(limiterNode);
  limiterNode.connect(destinationNode);

  return { audioContext, sourceNode, gainNode, limiterNode, destinationNode };
}

function disconnectGraph(graph: BoostGraph): void {
  graph.sourceNode.disconnect();
  graph.gainNode.disconnect();
  graph.limiterNode.disconnect();
}

function stopStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop());
}
