import type { Env } from "./env";
import {
  assertRelayRequestAllowed,
  parseRelayContentLength,
  parseRelayMaxBytes,
  parseSpilloverChunkPath,
  parseSpilloverIv,
  spilloverObjectKey,
  type SpilloverChunkLocation,
} from "./relay";
import { createRoomCode, roomIdFromCode, ROOM_CODE_PATTERN, ROOM_ID_PATTERN } from "../shared/roomCode";
import { captureStatsRollup, createStatsReportResponse } from "./stats";
import { createTurnCredentialsResponse } from "./turn";
import { roomTtlMs } from "./env";

export { TransferRoom } from "./room";
export { ClientSessionLimiter } from "./sessionLimiter";

const statsRequests = new Map<string, Promise<Response>>();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/api/rooms" && request.method === "POST") {
        return await createRoom(request, env);
      }

      if (url.pathname === "/api/turn-credentials" && request.method === "GET") {
        return await handleTurnCredentialsRequest(request, env);
      }

      if (url.pathname === "/api/stats" && request.method === "GET") {
        return await handleStatsRequest(request, env, ctx);
      }

      const spilloverLocation = parseSpilloverChunkPath(url.pathname);
      if (spilloverLocation) {
        return await handleSpilloverChunkRequest(request, env, spilloverLocation);
      }

      const roomMatch = /^\/api\/rooms\/([^/]+)$/.exec(url.pathname);
      if (roomMatch) {
        const roomId = decodeURIComponent(roomMatch[1]);
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return Response.json({ error: "websocket_upgrade_required" }, { status: 426 });
        }
        const rateLimit = await allowWebSocketAttempt(request, env);
        if (rateLimit) {
          return rateLimit;
        }
        const code = url.searchParams.get("code");
        if (!ROOM_ID_PATTERN.test(roomId) || !code || !ROOM_CODE_PATTERN.test(code) || roomId !== roomIdFromCode(code)) {
          return Response.json({ error: "invalid_room_code" }, { status: 403 });
        }
        const id = env.ROOMS.idFromName(roomId);
        const stub = env.ROOMS.get(id);

        return await stub.fetch(request);
      }

      if (url.pathname.startsWith("/api/")) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }

      return withSecurityHeaders(await env.ASSETS.fetch(request));
    } catch (error) {
      ctx.waitUntil(logUnexpectedError(error, request));
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(captureStatsRollup(env));
  },
} satisfies ExportedHandler<Env>;

async function createRoom(request: Request, env: Env): Promise<Response> {
  const clientKey = await clientLimiterKey(request);
  if (!clientKey) {
    return Response.json({ error: "client_ip_unavailable" }, { status: 400 });
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = createRoomCode();
    const roomId = roomIdFromCode(code);
    const expiresAt = Date.now() + roomTtlMs(env);
    const reservation = await sessionLimiterFetch(env, clientKey, "/reserve", { expiresAt, roomId });
    if (!reservation.ok) {
      return forwardJsonResponse(reservation);
    }

    const id = env.ROOMS.idFromName(roomId);
    const stub = env.ROOMS.get(id);
    let response: Response;
    try {
      response = await stub.fetch(
        new Request("https://room/init", {
          method: "POST",
          body: JSON.stringify({ roomId, code, clientKey, expiresAt }),
          headers: { "content-type": "application/json" },
        }),
      );
    } catch (error) {
      await sessionLimiterFetch(env, clientKey, "/release", { roomId });
      throw error;
    }

    if (response.status === 201) {
      return response;
    }

    await sessionLimiterFetch(env, clientKey, "/release", { roomId });
  }

  return Response.json({ error: "room_code_unavailable" }, { status: 503 });
}

async function handleSpilloverChunkRequest(
  request: Request,
  env: Env,
  location: SpilloverChunkLocation,
): Promise<Response> {
  const key = spilloverObjectKey(location);

  if (request.method === "PUT") {
    const maxBytes = Math.min(parseRelayMaxBytes(env.MAX_RELAY_REQUEST_BYTES), parseRelayMaxBytes(env.SPILLOVER_CAP_BYTES));
    const relayError = relayRequestError(request, maxBytes);
    if (relayError) {
      return relayError;
    }

    let ivBase64: string;
    try {
      ivBase64 = parseSpilloverIv(request.headers.get("x-spillover-iv"));
    } catch {
      return Response.json({ error: "spillover_iv_required" }, { status: 400 });
    }

    const contentLength = parseRelayContentLength(request.headers.get("content-length"));
    const authorization = await authorizeSpilloverRequest(env, location, request.headers.get("x-recovery-token"), "reserve", contentLength);
    if (authorization instanceof Response) {
      return authorization;
    }

    try {
      await env.SPILLOVER.put(key, request.body, {
        customMetadata: {
          chunkIndex: String(location.chunkIndex),
          expiresAt: String(authorization.expiresAt),
          fileId: location.fileId,
          ivBase64,
          roomId: location.roomId,
          transferId: location.transferId,
        },
        httpMetadata: {
          contentType: "application/octet-stream",
        },
      });
    } catch (error) {
      await updateSpilloverReservation(env, location, "release");
      throw error;
    }

    const committed = await updateSpilloverReservation(env, location, "commit");
    if (!committed.ok) {
      await env.SPILLOVER.delete(key);
      return forwardJsonResponse(committed);
    }

    return Response.json(
      {
        transferId: location.transferId,
        fileId: location.fileId,
        chunkIndex: location.chunkIndex,
        ivBase64,
        ciphertextBytes: contentLength,
        expiresAt: authorization.expiresAt,
      },
      { status: 201 },
    );
  }

  if (request.method === "GET") {
    const authorization = await authorizeSpilloverRequest(env, location, request.headers.get("x-recovery-token"), "read");
    if (authorization instanceof Response) {
      return authorization;
    }

    const object = await env.SPILLOVER.get(key);
    if (!object) {
      return Response.json({ error: "spillover_chunk_not_found" }, { status: 404 });
    }

    if (spilloverObjectExpired(object)) {
      await env.SPILLOVER.delete(key);
      await updateSpilloverReservation(env, location, "release");
      return Response.json({ error: "spillover_chunk_expired" }, { status: 410 });
    }

    return new Response(object.body, {
      headers: {
        "cache-control": "no-store",
        "content-length": String(object.size),
        "content-type": "application/octet-stream",
        "x-spillover-expires-at": object.customMetadata?.expiresAt ?? String(authorization.expiresAt),
        "x-spillover-iv": object.customMetadata?.ivBase64 ?? "",
      },
    });
  }

  if (request.method === "DELETE") {
    const authorization = await authorizeSpilloverRequest(env, location, request.headers.get("x-recovery-token"), "read");
    if (authorization instanceof Response) {
      return authorization;
    }

    await env.SPILLOVER.delete(key);
    await updateSpilloverReservation(env, location, "release");
    return new Response(null, { status: 204 });
  }

  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}

async function authorizeSpilloverRequest(
  env: Env,
  location: SpilloverChunkLocation,
  recoveryToken: string | null,
  action: "read" | "reserve",
  contentLength?: number,
): Promise<{ expiresAt: number } | Response> {
  if (!recoveryToken) {
    return Response.json({ error: "invalid_recovery_token" }, { status: 403 });
  }

  const id = env.ROOMS.idFromName(location.roomId);
  const stub = env.ROOMS.get(id);
  const response = await stub.fetch(
    new Request("https://room/authorize-spillover", {
      method: "POST",
      body: JSON.stringify({ action, contentLength, location, recoveryToken }),
      headers: { "content-type": "application/json" },
    }),
  );

  if (!response.ok) {
    return Response.json(await response.json(), { status: response.status });
  }

  const body: unknown = await response.json();
  if (!isSpilloverAuthorization(body)) {
    return Response.json({ error: "invalid_room_authorization" }, { status: 500 });
  }

  return { expiresAt: body.expiresAt };
}

async function updateSpilloverReservation(
  env: Env,
  location: SpilloverChunkLocation,
  action: "commit" | "release",
): Promise<Response> {
  const id = env.ROOMS.idFromName(location.roomId);
  return env.ROOMS.get(id).fetch(
    new Request("https://room/update-spillover", {
      method: "POST",
      body: JSON.stringify({ action, location }),
      headers: { "content-type": "application/json" },
    }),
  );
}

async function handleTurnCredentialsRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const roomId = url.searchParams.get("roomId");
  const recoveryToken = request.headers.get("x-recovery-token");
  if (!roomId || !ROOM_ID_PATTERN.test(roomId) || !recoveryToken) {
    return Response.json({ error: "room_authorization_required" }, { status: 403 });
  }

  const authorization = await env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(
    new Request("https://room/authorize-turn", {
      method: "POST",
      body: JSON.stringify({ recoveryToken }),
      headers: { "content-type": "application/json" },
    }),
  );
  if (!authorization.ok) {
    return forwardJsonResponse(authorization);
  }

  return createTurnCredentialsResponse(env);
}

async function handleStatsRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cacheKey = statsCacheRequest(request);
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  const key = cacheKey.url;
  const existing = statsRequests.get(key);
  if (existing) {
    return (await existing).clone();
  }

  const pending = createStatsReportResponse(request, env).then((response) => {
    if (!response.ok) {
      return response;
    }

    const headers = new Headers(response.headers);
    headers.set("cache-control", "public, max-age=300, stale-while-revalidate=300");
    return new Response(response.body, { status: response.status, headers });
  });
  statsRequests.set(key, pending);

  try {
    const response = await pending;
    if (response.ok) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response.clone();
  } finally {
    statsRequests.delete(key);
  }
}

export function statsCacheRequest(request: Request): Request {
  const url = new URL(request.url);
  const canonicalUrl = new URL("/api/stats", url.origin);
  canonicalUrl.searchParams.set("range", url.searchParams.get("range") ?? "");
  return new Request(canonicalUrl, { method: "GET" });
}

async function allowWebSocketAttempt(request: Request, env: Env): Promise<Response | null> {
  const clientKey = await clientLimiterKey(request);
  if (!clientKey) {
    return Response.json({ error: "client_ip_unavailable" }, { status: 400 });
  }

  const response = await sessionLimiterFetch(env, clientKey, "/allow-websocket", {});
  if (response.ok) {
    return null;
  }

  return forwardJsonResponse(response);
}

async function sessionLimiterFetch(env: Env, clientKey: string, path: string, body: unknown): Promise<Response> {
  const id = env.SESSION_LIMITERS.idFromName(clientKey);
  return env.SESSION_LIMITERS.get(id).fetch(
    new Request(`https://limiter${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

async function clientLimiterKey(request: Request): Promise<string | null> {
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  if (!ip) {
    return null;
  }

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function forwardJsonResponse(response: Response): Promise<Response> {
  return Response.json(await response.json(), {
    status: response.status,
    headers: response.headers.get("retry-after") ? { "retry-after": response.headers.get("retry-after")! } : undefined,
  });
}

function relayRequestError(request: Request, maxBytes: number): Response | null {
  try {
    const contentLength = parseRelayContentLength(request.headers.get("content-length"));
    assertRelayRequestAllowed(contentLength, maxBytes);
    return null;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    if (error.message === "content length is required") {
      return Response.json({ error: "content_length_required" }, { status: 411 });
    }

    if (error.message === "relay request exceeds configured limit") {
      return Response.json({ error: "relay_request_too_large" }, { status: 413 });
    }

    throw error;
  }
}

function spilloverObjectExpired(object: R2Object): boolean {
  const expiresAt = Number(object.customMetadata?.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function isSpilloverAuthorization(value: unknown): value is { expiresAt: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "expiresAt" in value &&
    typeof value.expiresAt === "number"
  );
}

function logUnexpectedError(error: unknown, request: Request): Promise<void> {
  const url = new URL(request.url);
  const message = error instanceof Error ? error.message : String(error);

  return Promise.resolve().then(() => {
    console.error(
      JSON.stringify({
        level: "error",
        event: "worker.unexpected_error",
        path: url.pathname,
        message,
      }),
    );
  });
}

export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "content-security-policy",
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss:; img-src 'self' data: blob:; font-src 'self'; worker-src 'self' blob:; upgrade-insecure-requests",
  );
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("referrer-policy", "no-referrer");
  headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
