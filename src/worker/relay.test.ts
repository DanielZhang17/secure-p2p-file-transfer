/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  assertRelayRequestAllowed,
  parseRelayContentLength,
  parseRelayMaxBytes,
} from "./relay";

describe("assertRelayRequestAllowed", () => {
  it("accepts requests at or below the configured byte limit", () => {
    expect(() => assertRelayRequestAllowed(64 * 1024 * 1024 - 1, 64 * 1024 * 1024)).not.toThrow();
    expect(() => assertRelayRequestAllowed(64 * 1024 * 1024, 64 * 1024 * 1024)).not.toThrow();
  });

  it("rejects requests above the configured byte limit", () => {
    expect(() => assertRelayRequestAllowed(64 * 1024 * 1024 + 1, 64 * 1024 * 1024)).toThrow(
      "relay request exceeds configured limit",
    );
  });

  it("rejects invalid configured byte limits", () => {
    for (const maxBytes of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0,
      -1,
      64 * 1024 * 1024 + 0.5,
    ]) {
      expect(() => assertRelayRequestAllowed(1, maxBytes)).toThrow("relay limit is not configured");
    }
  });

  it("rejects missing content length", () => {
    expect(() => assertRelayRequestAllowed(Number.NaN, 64 * 1024 * 1024)).toThrow(
      "content length is required",
    );
  });

  it("rejects invalid content length", () => {
    expect(() => assertRelayRequestAllowed(Number.NaN, 64 * 1024 * 1024)).toThrow(
      "content length is required",
    );
    expect(() => assertRelayRequestAllowed(Number.POSITIVE_INFINITY, 64 * 1024 * 1024)).toThrow(
      "content length is required",
    );
  });

  it("rejects negative content length", () => {
    expect(() => assertRelayRequestAllowed(-1, 64 * 1024 * 1024)).toThrow(
      "content length is required",
    );
  });
});

describe("parseRelayContentLength", () => {
  it("accepts ASCII decimal digits", () => {
    expect(parseRelayContentLength("0")).toBe(0);
    expect(parseRelayContentLength("123")).toBe(123);
  });

  it("rejects missing, empty, or malformed values", () => {
    for (const value of [null, "", "1junk", "1, 67108865", "1e9"]) {
      expect(() => parseRelayContentLength(value)).toThrow("content length is required");
    }
  });
});

describe("parseRelayMaxBytes", () => {
  it("accepts ASCII decimal digits", () => {
    expect(parseRelayMaxBytes("67108864")).toBe(64 * 1024 * 1024);
  });

  it("rejects missing, empty, or malformed values", () => {
    for (const value of [null, "", "1junk", "1, 67108865", "1e9"]) {
      expect(() => parseRelayMaxBytes(value)).toThrow("relay limit is not configured");
    }
  });
});

describe("relay worker route", () => {
  it("does not expose the unauthenticated echo relay", async () => {
    const response = await SELF.fetch("https://example.com/api/relay", {
      method: "POST",
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("stores, reads, and deletes encrypted spillover chunks for a joined room peer", async () => {
    const room = await createRoom();
    const sender = await connectToRoom(room);
    const recipient = await connectToRoom(room);
    sender.socket.send(JSON.stringify({ type: "join", role: "sender" }));
    recipient.socket.send(JSON.stringify({ type: "join", role: "recipient" }));
    const senderRecoveryToken = await waitForRecoveryToken(sender.messages);
    const recipientRecoveryToken = await waitForRecoveryToken(recipient.messages);
    const body = new Uint8Array([9, 8, 7, 6]);
    const path = `https://example.com/api/rooms/${room.roomId}/spillover/transfer-1/file-1/0`;

    const putResponse = await SELF.fetch(path, {
      method: "PUT",
      headers: {
        "content-length": String(body.byteLength),
        "x-recovery-token": senderRecoveryToken,
        "x-spillover-iv": "MDEyMzQ1Njc4OWFi",
      },
      body,
    });

    expect(putResponse.status).toBe(201);
    await expect(putResponse.json()).resolves.toMatchObject({
      transferId: "transfer-1",
      fileId: "file-1",
      chunkIndex: 0,
      ivBase64: "MDEyMzQ1Njc4OWFi",
      ciphertextBytes: body.byteLength,
      expiresAt: room.expiresAt,
    });

    const overwriteResponse = await SELF.fetch(path, {
      method: "PUT",
      headers: {
        "content-length": String(body.byteLength),
        "x-recovery-token": senderRecoveryToken,
        "x-spillover-iv": "MDEyMzQ1Njc4OWFi",
      },
      body,
    });
    expect(overwriteResponse.status).toBe(409);
    await expect(overwriteResponse.json()).resolves.toEqual({ error: "spillover_chunk_exists" });

    const senderReadResponse = await SELF.fetch(path, {
      headers: { "x-recovery-token": senderRecoveryToken },
    });
    expect(senderReadResponse.status).toBe(403);
    await expect(senderReadResponse.json()).resolves.toEqual({ error: "spillover_recipient_required" });

    const getResponse = await SELF.fetch(path, {
      headers: { "x-recovery-token": recipientRecoveryToken },
    });

    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get("content-type")).toBe("application/octet-stream");
    expect(getResponse.headers.get("x-spillover-iv")).toBe("MDEyMzQ1Njc4OWFi");
    expect(new Uint8Array(await getResponse.arrayBuffer())).toEqual(body);

    const deleteResponse = await SELF.fetch(path, {
      method: "DELETE",
      headers: { "x-recovery-token": recipientRecoveryToken },
    });
    expect(deleteResponse.status).toBe(204);

    const missingResponse = await SELF.fetch(path, {
      headers: { "x-recovery-token": recipientRecoveryToken },
    });
    expect(missingResponse.status).toBe(404);

    sender.socket.close();
    recipient.socket.close();
  });

  it("rejects spillover uploads without a valid room recovery token", async () => {
    const room = await createRoom();
    const body = new Uint8Array([1, 2, 3]);
    const path = `https://example.com/api/rooms/${room.roomId}/spillover/transfer-1/file-1/0`;

    const response = await SELF.fetch(path, {
      method: "PUT",
      headers: {
        "content-length": String(body.byteLength),
        "x-recovery-token": "wrong-token",
        "x-spillover-iv": "MDEyMzQ1Njc4OWFi",
      },
      body,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "invalid_recovery_token" });
  });
});

interface CreateRoomResponse {
  roomId: string;
  code: string;
  expiresAt: number;
}

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

async function connectToRoom(room: CreateRoomResponse): Promise<{ messages: unknown[]; socket: WebSocket }> {
  const response = await SELF.fetch(`https://example.com/api/rooms/${room.roomId}?code=${room.code}`, {
    headers: { ...clientIpHeader(), Upgrade: "websocket" },
  });
  const socket = response.webSocket;

  expect(response.status).toBe(101);
  if (!socket) {
    throw new Error("expected websocket");
  }

  const messages: unknown[] = [];
  socket.accept();
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)));
  });

  return { messages, socket };
}

let nextIpSuffix = 100;

function clientIpHeader(): Record<string, string> {
  nextIpSuffix += 1;
  return { "cf-connecting-ip": `192.0.2.${nextIpSuffix}` };
}

async function waitForRecoveryToken(messages: unknown[]): Promise<string> {
  await vi.waitFor(() => {
    expect(messages).toContainEqual(expect.objectContaining({ type: "joined", recoveryToken: expect.any(String) }));
  });
  const joined = messages.find(isJoinedMessage);
  if (!joined) {
    throw new Error("expected joined message");
  }

  return joined.recoveryToken;
}

function isJoinedMessage(value: unknown): value is { type: "joined"; recoveryToken: string } {
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
