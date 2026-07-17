/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env as cloudflareEnv } from "cloudflare:workers";
import { SELF, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { statsCacheRequest, withSecurityHeaders } from "./index";
import { roomCodesEqual } from "./room";

interface CreateRoomResponse {
  roomId: string;
  code: string;
  expiresAt: number;
}

interface TimingSafeSubtleCrypto extends SubtleCrypto {
  timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
}

describe("room worker", () => {
  it("creates a room with a short pairing code", async () => {
    const response = await SELF.fetch("https://example.com/api/rooms", {
      method: "POST",
      headers: clientIpHeader(),
    });
    const body: unknown = await response.json();

    expect(response.status).toBe(201);
    expect(isCreateRoomResponse(body)).toBe(true);

    if (!isCreateRoomResponse(body)) {
      throw new Error("expected room creation response");
    }

    expect(body.roomId).toMatch(/^room-/);
    expect(body.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(Object.keys(body).sort()).toEqual(["code", "expiresAt", "roomId"]);
  });

  it("rejects websocket upgrades for rooms that were never created", async () => {
    const response = await SELF.fetch("https://example.com/api/rooms/room-ABCDEF?code=ABCDEF", {
      headers: { ...clientIpHeader(), Upgrade: "websocket" },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "room_not_found" });
  });

  it("requires the room code before accepting websocket upgrades", async () => {
    const room = await createRoom();

    const response = await SELF.fetch(`https://example.com/api/rooms/${room.roomId}`, {
      headers: { ...clientIpHeader(), Upgrade: "websocket" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "invalid_room_code" });
  });

  it("acknowledges joined peers and notifies when the other role arrives", async () => {
    const room = await createRoom();
    const sender = await connectToRoom(room, "sender");
    const recipient = await connectToRoom(room, "recipient");

    sender.socket.send(JSON.stringify({ type: "join", role: "sender" }));
    recipient.socket.send(JSON.stringify({ type: "join", role: "recipient" }));

    await vi.waitFor(() => {
      expect(sender.messages).toContainEqual({
        type: "joined",
        roomId: room.roomId,
        role: "sender",
        recoveryToken: expect.any(String),
        expiresAt: room.expiresAt,
      });
      expect(sender.messages).toContainEqual({ type: "peer-joined", role: "recipient" });
      expect(recipient.messages).toContainEqual({
        type: "joined",
        roomId: room.roomId,
        role: "recipient",
        recoveryToken: expect.any(String),
        expiresAt: room.expiresAt,
      });
      expect(recipient.messages).toContainEqual({ type: "peer-joined", role: "sender" });
    });

    sender.socket.close();
    recipient.socket.close();
  });

  it("forwards signaling messages between joined peers", async () => {
    const room = await createRoom();
    const sender = await connectToRoom(room, "sender");
    const recipient = await connectToRoom(room, "recipient");

    sender.socket.send(JSON.stringify({ type: "join", role: "sender" }));
    recipient.socket.send(JSON.stringify({ type: "join", role: "recipient" }));
    await vi.waitFor(() => {
      expect(recipient.messages).toContainEqual({ type: "peer-joined", role: "sender" });
    });

    sender.socket.send(JSON.stringify({ type: "signal", payload: { type: "offer", sdp: "offer-sdp" } }));

    await vi.waitFor(() => {
      expect(recipient.messages).toContainEqual({ type: "signal", payload: { type: "offer", sdp: "offer-sdp" } });
    });

    sender.socket.close();
    recipient.socket.close();
  });

  it("forwards transfer control messages and spillover references between joined peers", async () => {
    const room = await createRoom();
    const sender = await connectToRoom(room, "sender");
    const recipient = await connectToRoom(room, "recipient");

    sender.socket.send(JSON.stringify({ type: "join", role: "sender" }));
    recipient.socket.send(JSON.stringify({ type: "join", role: "recipient" }));
    await vi.waitFor(() => {
      expect(recipient.messages).toContainEqual({ type: "peer-joined", role: "sender" });
    });

    sender.socket.send(
      JSON.stringify({
        type: "transfer",
        message: {
          type: "key-exchange",
          transferId: "transfer-1",
          publicKeyBase64: "cHVibGljLWtleQ==",
        },
      }),
    );
    sender.socket.send(
      JSON.stringify({
        type: "spillover-chunk",
        chunk: {
          transferId: "transfer-1",
          fileId: "file-1",
          chunkIndex: 0,
          ivBase64: "MDEyMzQ1Njc4OWFi",
          ciphertextBytes: 128,
        },
      }),
    );

    await vi.waitFor(() => {
      expect(recipient.messages).toContainEqual({
        type: "transfer",
        message: {
          type: "key-exchange",
          transferId: "transfer-1",
          publicKeyBase64: "cHVibGljLWtleQ==",
        },
      });
      expect(recipient.messages).toContainEqual({
        type: "spillover-chunk",
        chunk: {
          transferId: "transfer-1",
          fileId: "file-1",
          chunkIndex: 0,
          ivBase64: "MDEyMzQ1Njc4OWFi",
          ciphertextBytes: 128,
        },
      });
    });

    sender.socket.close();
    recipient.socket.close();
  });

  it("reuses a recovery token when a peer reconnects within the room lifetime", async () => {
    const room = await createRoom();
    const sender = await connectToRoom(room, "sender");
    const recipient = await connectToRoom(room, "recipient");

    sender.socket.send(JSON.stringify({ type: "join", role: "sender" }));
    recipient.socket.send(JSON.stringify({ type: "join", role: "recipient" }));

    await vi.waitFor(() => {
      expect(sender.messages).toContainEqual(expect.objectContaining({ type: "joined", role: "sender" }));
      expect(recipient.messages).toContainEqual({ type: "peer-joined", role: "sender" });
    });

    const joined = sender.messages.find(isJoinedMessage);
    if (!joined) {
      throw new Error("expected sender joined message");
    }
    sender.socket.close();

    const reconnectedSender = await connectToRoom(room, "sender");
    reconnectedSender.socket.send(JSON.stringify({ type: "join", role: "sender", recoveryToken: joined.recoveryToken }));

    await vi.waitFor(() => {
      expect(reconnectedSender.messages).toContainEqual({
        type: "joined",
        roomId: room.roomId,
        role: "sender",
        recoveryToken: joined.recoveryToken,
        expiresAt: room.expiresAt,
      });
      expect(reconnectedSender.messages).toContainEqual({ type: "peer-joined", role: "recipient" });
      expect(recipient.messages).toContainEqual({ type: "peer-joined", role: "sender" });
    });

    reconnectedSender.socket.close();
    recipient.socket.close();
  });

  it("rejects a pairing-code holder that tries to take an already owned role", async () => {
    const room = await createRoom();
    const owner = await connectToRoom(room, "sender");
    owner.socket.send(JSON.stringify({ type: "join", role: "sender" }));
    await vi.waitFor(() => expect(owner.messages).toContainEqual(expect.objectContaining({ type: "joined", role: "sender" })));

    const attacker = await connectToRoom(room, "sender");
    attacker.socket.send(JSON.stringify({ type: "join", role: "sender" }));

    await vi.waitFor(() => {
      expect(attacker.messages).toContainEqual(expect.objectContaining({ type: "error", code: "role_unavailable" }));
    });
    owner.socket.close();
    attacker.socket.close();
  });

  it("does not forward messages from a socket that has not joined a role", async () => {
    const room = await createRoom();
    const sender = await connectToRoom(room, "sender");
    const recipient = await connectToRoom(room, "recipient");
    recipient.socket.send(JSON.stringify({ type: "join", role: "recipient" }));
    await vi.waitFor(() => expect(recipient.messages).toContainEqual(expect.objectContaining({ type: "joined" })));

    sender.socket.send(JSON.stringify({ type: "signal", payload: { type: "offer", sdp: "attacker-offer" } }));

    await vi.waitFor(() => {
      expect(sender.messages).toContainEqual(expect.objectContaining({ type: "error", code: "join_required" }));
    });
    expect(recipient.messages).not.toContainEqual({ type: "signal", payload: { type: "offer", sdp: "attacker-offer" } });
    sender.socket.close();
    recipient.socket.close();
  });

  it("limits one IP to eight active rooms", async () => {
    const headers = { "cf-connecting-ip": "198.51.100.77" };
    const responses: Response[] = [];
    for (let index = 0; index < 9; index += 1) {
      responses.push(await SELF.fetch("https://example.com/api/rooms", { method: "POST", headers }));
    }

    expect(responses.slice(0, 8).every((response) => response.status === 201)).toBe(true);
    expect(responses[8].status).toBe(429);
    await expect(responses[8].json()).resolves.toMatchObject({ allowed: false, activeSessions: 8 });

    const firstRoom: unknown = await responses[0].json();
    if (!isCreateRoomResponse(firstRoom)) {
      throw new Error("expected first limited room");
    }
    await runDurableObjectAlarm(cloudflareEnv.ROOMS.get(cloudflareEnv.ROOMS.idFromName(firstRoom.roomId)));

    const replacement = await SELF.fetch("https://example.com/api/rooms", { method: "POST", headers });
    expect(replacement.status).toBe(201);
  });

  it("compares fixed-length room codes with timing-safe equality", () => {
    const timingSafeEqual = vi.spyOn(crypto.subtle as TimingSafeSubtleCrypto, "timingSafeEqual");

    try {
      expect(roomCodesEqual("ABCDEF", "ABCDEF")).toBe(true);
      expect(roomCodesEqual("ABCDEG", "ABCDEF")).toBe(false);
      expect(roomCodesEqual("ABC", "ABCDEF")).toBe(false);
      expect(timingSafeEqual).toHaveBeenCalledTimes(2);
    } finally {
      timingSafeEqual.mockRestore();
    }
  });

  it("rejects websocket upgrades after the room alarm expires state", async () => {
    const room = await createRoom();
    const rooms = cloudflareEnv.ROOMS;
    const id = rooms.idFromName(room.roomId);
    const stub = rooms.get(id);

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const response = await SELF.fetch(`https://example.com/api/rooms/${room.roomId}?code=${room.code}`, {
      headers: { ...clientIpHeader(), Upgrade: "websocket" },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "room_not_found" });
  });

  it("rejects unknown API routes", async () => {
    const response = await SELF.fetch("https://example.com/api/missing");

    expect(response.status).toBe(404);
  });

  it("adds browser hardening headers to public assets", async () => {
    const response = withSecurityHeaders(new Response("ok", { headers: { "content-type": "text/html" } }));

    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("canonicalizes stats cache keys so irrelevant parameters cannot bypass caching", () => {
    const first = statsCacheRequest(new Request("https://example.com/api/stats?range=day&nonce=one"));
    const second = statsCacheRequest(new Request("https://example.com/api/stats?nonce=two&range=day"));

    expect(first.url).toBe("https://example.com/api/stats?range=day");
    expect(second.url).toBe(first.url);
  });
});

async function createRoom(): Promise<CreateRoomResponse> {
  const response = await SELF.fetch("https://example.com/api/rooms", {
    method: "POST",
    headers: clientIpHeader(),
  });
  const body: unknown = await response.json();

  if (!isCreateRoomResponse(body)) {
    throw new Error("expected room creation response");
  }

  return body;
}

async function connectToRoom(
  room: CreateRoomResponse,
  role: "sender" | "recipient",
): Promise<{ messages: unknown[]; socket: WebSocket }> {
  const response = await SELF.fetch(`https://example.com/api/rooms/${room.roomId}?code=${room.code}`, {
    headers: { ...clientIpHeader(), Upgrade: "websocket" },
  });
  const socket = response.webSocket;

  expect(response.status).toBe(101);
  if (!socket) {
    throw new Error(`expected ${role} websocket`);
  }

  const messages: unknown[] = [];
  socket.accept();
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)));
  });

  return { messages, socket };
}

let nextIpSuffix = 1;

function clientIpHeader(): Record<string, string> {
  nextIpSuffix += 1;
  return { "cf-connecting-ip": `192.0.2.${nextIpSuffix}` };
}

function isJoinedMessage(value: unknown): value is {
  type: "joined";
  roomId: string;
  role: "sender" | "recipient";
  recoveryToken: string;
  expiresAt: number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "joined" &&
    "recoveryToken" in value &&
    typeof value.recoveryToken === "string"
  );
}

function isCreateRoomResponse(value: unknown): value is CreateRoomResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "roomId" in value &&
    "code" in value &&
    "expiresAt" in value &&
    typeof value.roomId === "string" &&
    typeof value.code === "string" &&
    typeof value.expiresAt === "number"
  );
}
