export interface RealtimeWebRtcTransport {
  peerConnection: RTCPeerConnection;
  dataChannel: RTCDataChannel;
  sendEvent: (event: unknown) => boolean;
  close: () => void;
}

interface RealtimeWebRtcOptions {
  callUrl: string;
  clientSecret: string;
  stream: MediaStream;
  onOpen: (transport: RealtimeWebRtcTransport) => void;
  onMessage: (data: unknown) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

export async function createRealtimeWebRtcTransport({
  callUrl,
  clientSecret,
  stream,
  onOpen,
  onMessage,
  onError,
  onClose
}: RealtimeWebRtcOptions): Promise<RealtimeWebRtcTransport> {
  const peerConnection = new RTCPeerConnection();
  const dataChannel = peerConnection.createDataChannel("oai-events");

  const sendEvent = (event: unknown) => {
    if (dataChannel.readyState !== "open") {
      return false;
    }

    dataChannel.send(JSON.stringify(event));
    return true;
  };

  const close = () => {
    if (dataChannel.readyState !== "closed") {
      dataChannel.close();
    }
    if (peerConnection.connectionState !== "closed") {
      peerConnection.close();
    }
  };

  const transport: RealtimeWebRtcTransport = {
    peerConnection,
    dataChannel,
    sendEvent,
    close
  };

  dataChannel.onopen = () => onOpen(transport);
  dataChannel.onmessage = (message) => onMessage(message.data);
  dataChannel.onerror = () => onError("Realtime WebRTC data channel failed. Check the network connection.");
  dataChannel.onclose = onClose;

  peerConnection.onconnectionstatechange = () => {
    if (peerConnection.connectionState === "failed") {
      onError("Realtime WebRTC connection failed. Check the network connection.");
      return;
    }

    if (peerConnection.connectionState === "closed") {
      onClose();
    }
  };

  for (const track of stream.getAudioTracks()) {
    peerConnection.addTrack(track, stream);
  }

  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    if (!peerConnection.localDescription?.sdp) {
      throw new Error("The browser did not create a Realtime WebRTC offer.");
    }

    const response = await fetch(callUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        "Content-Type": "application/sdp"
      },
      body: peerConnection.localDescription.sdp
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Realtime WebRTC connection failed: ${response.status} ${detail}`);
    }

    const answerSdp = await response.text();
    await peerConnection.setRemoteDescription({ type: "answer", sdp: answerSdp });
    return transport;
  } catch (error) {
    close();
    throw error;
  }
}
