import { DurableObject } from "cloudflare:workers";
import { isSafeIdentifier } from "../shared/protocolValidation";
import type { Env } from "./env";

interface LimiterState {
  joinAttempts: number[];
  sessions: Record<string, number>;
}

interface SessionBody {
  expiresAt: number;
  roomId: string;
}

const STATE_KEY = "state";
const MAX_ACTIVE_SESSIONS = 8;
const MAX_JOIN_ATTEMPTS_PER_MINUTE = 60;
const JOIN_WINDOW_MS = 60_000;

export class ClientSessionLimiter extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/reserve") && request.method === "POST") {
      return this.reserve(request);
    }

    if (url.pathname.endsWith("/release") && request.method === "POST") {
      return this.release(request);
    }

    if (url.pathname.endsWith("/allow-websocket") && request.method === "POST") {
      return this.allowWebSocket();
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private async reserve(request: Request): Promise<Response> {
    const input: unknown = await request.json();
    if (!isSessionBody(input)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    const now = Date.now();
    const result = await this.ctx.storage.transaction(async (txn) => {
      const state = pruneState((await txn.get<LimiterState>(STATE_KEY)) ?? emptyState(), now);
      if (state.sessions[input.roomId]) {
        return { allowed: true, activeSessions: Object.keys(state.sessions).length };
      }

      const activeSessions = Object.keys(state.sessions).length;
      if (activeSessions >= MAX_ACTIVE_SESSIONS) {
        return {
          allowed: false,
          activeSessions,
          retryAfter: retryAfterSeconds(Object.values(state.sessions), now),
        };
      }

      state.sessions[input.roomId] = input.expiresAt;
      await txn.put(STATE_KEY, state);
      return { allowed: true, activeSessions: activeSessions + 1 };
    });

    return Response.json(result, {
      status: result.allowed ? 200 : 429,
      headers: result.allowed ? undefined : { "retry-after": String(result.retryAfter) },
    });
  }

  private async release(request: Request): Promise<Response> {
    const input: unknown = await request.json();
    if (!isRecord(input) || !isSafeIdentifier(input.roomId)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const roomId = input.roomId;

    await this.ctx.storage.transaction(async (txn) => {
      const state = pruneState((await txn.get<LimiterState>(STATE_KEY)) ?? emptyState(), Date.now());
      delete state.sessions[roomId];
      await txn.put(STATE_KEY, state);
    });

    return new Response(null, { status: 204 });
  }

  private async allowWebSocket(): Promise<Response> {
    const now = Date.now();
    const result = await this.ctx.storage.transaction(async (txn) => {
      const state = pruneState((await txn.get<LimiterState>(STATE_KEY)) ?? emptyState(), now);
      if (state.joinAttempts.length >= MAX_JOIN_ATTEMPTS_PER_MINUTE) {
        return {
          allowed: false,
          retryAfter: Math.max(1, Math.ceil((state.joinAttempts[0] + JOIN_WINDOW_MS - now) / 1000)),
        };
      }

      state.joinAttempts.push(now);
      await txn.put(STATE_KEY, state);
      return { allowed: true };
    });

    return Response.json(result, {
      status: result.allowed ? 200 : 429,
      headers: result.allowed ? undefined : { "retry-after": String(result.retryAfter) },
    });
  }
}

function emptyState(): LimiterState {
  return { joinAttempts: [], sessions: {} };
}

function pruneState(state: LimiterState, now: number): LimiterState {
  return {
    joinAttempts: state.joinAttempts.filter((attempt) => attempt > now - JOIN_WINDOW_MS),
    sessions: Object.fromEntries(Object.entries(state.sessions).filter(([, expiresAt]) => expiresAt > now)),
  };
}

function retryAfterSeconds(expiries: number[], now: number): number {
  return Math.max(1, Math.ceil((Math.min(...expiries) - now) / 1000));
}

function isSessionBody(value: unknown): value is SessionBody {
  return (
    isRecord(value) &&
    isSafeIdentifier(value.roomId) &&
    typeof value.expiresAt === "number" &&
    Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt > Date.now()
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
