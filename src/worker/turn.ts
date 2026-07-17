export interface TurnCredentialsEnv {
  TURN_KEY_API_TOKEN?: string;
  TURN_KEY_ID?: string;
  TURN_TTL_SECONDS?: string;
}

interface TurnCredentialsApiResponse {
  iceServers: RTCIceServer[];
}

const DEFAULT_TURN_TTL_SECONDS = 900;
const MAX_TURN_TTL_SECONDS = 3_600;

export async function createTurnCredentialsResponse(
  env: TurnCredentialsEnv,
  fetchTurnCredentials: typeof fetch = fetch,
): Promise<Response> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    return noStoreJson({ error: "turn_not_configured" }, 503);
  }

  const ttl = parseTurnTtlSeconds(env.TURN_TTL_SECONDS);
  const response = await fetchTurnCredentials(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(
      env.TURN_KEY_ID,
    )}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl }),
    },
  );

  if (!response.ok) {
    return noStoreJson({ error: "turn_credentials_unavailable" }, 502);
  }

  const body: unknown = await response.json();
  if (!isTurnCredentialsApiResponse(body)) {
    return noStoreJson({ error: "turn_credentials_invalid" }, 502);
  }

  return noStoreJson({
    expiresAt: Date.now() + ttl * 1000,
    iceServers: body.iceServers,
  });
}

function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function parseTurnTtlSeconds(value: string | undefined): number {
  if (!value) {
    return DEFAULT_TURN_TTL_SECONDS;
  }

  const ttl = Number(value);
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_TURN_TTL_SECONDS) {
    return DEFAULT_TURN_TTL_SECONDS;
  }

  return ttl;
}

function isTurnCredentialsApiResponse(value: unknown): value is TurnCredentialsApiResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "iceServers" in value &&
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
