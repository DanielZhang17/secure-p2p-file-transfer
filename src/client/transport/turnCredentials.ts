interface TurnCredentialsResponse {
  expiresAt: number;
  iceServers: RTCIceServer[];
}

export async function loadTurnIceServers(roomId?: string, recoveryToken?: string): Promise<RTCIceServer[]> {
  if (!roomId || !recoveryToken) {
    return [];
  }

  try {
    const response = await fetch(`/api/turn-credentials?roomId=${encodeURIComponent(roomId)}`, {
      method: "GET",
      headers: { "x-recovery-token": recoveryToken },
    });
    if (!response.ok) {
      return [];
    }

    const body: unknown = await response.json();
    if (!isTurnCredentialsResponse(body) || body.expiresAt <= Date.now()) {
      return [];
    }

    return body.iceServers;
  } catch {
    return [];
  }
}

function isTurnCredentialsResponse(value: unknown): value is TurnCredentialsResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "expiresAt" in value &&
    "iceServers" in value &&
    typeof value.expiresAt === "number" &&
    Array.isArray(value.iceServers) &&
    value.iceServers.every(isRtcIceServer)
  );
}

function isRtcIceServer(value: unknown): value is RTCIceServer {
  if (typeof value !== "object" || value === null || !("urls" in value)) {
    return false;
  }

  const server = value as { credential?: unknown; urls: unknown; username?: unknown };
  return (
    (typeof server.urls === "string" || (Array.isArray(server.urls) && server.urls.every((url) => typeof url === "string"))) &&
    (server.username === undefined || typeof server.username === "string") &&
    (server.credential === undefined || typeof server.credential === "string")
  );
}
