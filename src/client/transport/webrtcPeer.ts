export function buildRtcConfiguration(iceServers: RTCIceServer[] = []): RTCConfiguration {
  return { iceServers };
}

export function createPeerConnection(iceServers: RTCIceServer[] = []): RTCPeerConnection {
  return new RTCPeerConnection(buildRtcConfiguration(iceServers));
}
