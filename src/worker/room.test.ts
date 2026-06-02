/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env as cloudflareEnv } from "cloudflare:workers";
import { SELF, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
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
    const response = await SELF.fetch("https://example.com/api/rooms", { method: "POST" });
    const body: unknown = await response.json();

    expect(response.status).toBe(201);
    expect(isCreateRoomResponse(body)).toBe(true);

    if (!isCreateRoomResponse(body)) {
      throw new Error("expected room creation response");
    }

    expect(body.roomId).toMatch(/^room-/);
    expect(body.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("rejects websocket upgrades for rooms that were never created", async () => {
    const response = await SELF.fetch("https://example.com/api/rooms/room-missing", {
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "room_not_found" });
  });

  it("requires the room code before accepting websocket upgrades", async () => {
    const room = await createRoom();

    const response = await SELF.fetch(`https://example.com/api/rooms/${room.roomId}`, {
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "invalid_room_code" });
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
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "room_not_found" });
  });

  it("rejects unknown API routes", async () => {
    const response = await SELF.fetch("https://example.com/api/missing");

    expect(response.status).toBe(404);
  });
});

async function createRoom(): Promise<CreateRoomResponse> {
  const response = await SELF.fetch("https://example.com/api/rooms", { method: "POST" });
  const body: unknown = await response.json();

  if (!isCreateRoomResponse(body)) {
    throw new Error("expected room creation response");
  }

  return body;
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
