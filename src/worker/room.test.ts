/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface CreateRoomResponse {
  roomId: string;
  code: string;
  expiresAt: number;
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

  it("rejects unknown API routes", async () => {
    const response = await SELF.fetch("https://example.com/api/missing");

    expect(response.status).toBe(404);
  });
});

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
