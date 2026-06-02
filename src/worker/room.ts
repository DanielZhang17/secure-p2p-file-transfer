import { DurableObject } from "cloudflare:workers";
import type { ServerRoomMessage } from "../shared/protocol";
import { roomTtlMs, type Env } from "./env";

interface RoomRecord {
  roomId: string;
  code: string;
  expiresAt: number;
}

interface InitRoomBody {
  roomId: string;
}

const ROOM_STORAGE_KEY = "room";
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class TransferRoom extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/init") && request.method === "POST") {
      return this.initRoom(request);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.acceptSocket(request);
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const type = roomMessageType(message);
    const reply: ServerRoomMessage = {
      type: "error",
      code: "not-ready",
      message: `received ${type}`,
    };

    ws.send(JSON.stringify(reply));
  }

  private async initRoom(request: Request): Promise<Response> {
    const input: unknown = await request.json();
    if (!isInitRoomBody(input)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    const result = await this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<RoomRecord>(ROOM_STORAGE_KEY);
      if (existing) {
        return { record: existing, status: 200 };
      }

      const record: RoomRecord = {
        roomId: input.roomId,
        code: roomCode(),
        expiresAt: Date.now() + roomTtlMs(this.env),
      };

      await txn.put(ROOM_STORAGE_KEY, record);
      await txn.setAlarm(record.expiresAt);

      return { record, status: 201 };
    });

    return Response.json(result.record, { status: result.status });
  }

  private async acceptSocket(request: Request): Promise<Response> {
    const record = await this.ctx.storage.get<RoomRecord>(ROOM_STORAGE_KEY);

    if (!record) {
      return Response.json({ error: "room_not_found" }, { status: 404 });
    }

    if (record.expiresAt <= Date.now()) {
      await this.ctx.storage.deleteAll();
      return Response.json({ error: "room_expired" }, { status: 410 });
    }

    const url = new URL(request.url);
    if (url.searchParams.get("code") !== record.code) {
      return Response.json({ error: "invalid_room_code" }, { status: 403 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }
}

function roomCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);

  return Array.from(bytes, (byte) => ROOM_CODE_ALPHABET[byte & 31]).join("");
}

function isInitRoomBody(value: unknown): value is InitRoomBody {
  return isRecord(value) && typeof value.roomId === "string" && value.roomId.length > 0;
}

function roomMessageType(message: string | ArrayBuffer): string {
  if (typeof message !== "string") {
    return "binary";
  }

  try {
    const parsed: unknown = JSON.parse(message);
    if (isRecord(parsed) && typeof parsed.type === "string") {
      return parsed.type;
    }
  } catch {
    return "unknown";
  }

  return "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
