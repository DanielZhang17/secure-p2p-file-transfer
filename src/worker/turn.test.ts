/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createTurnCredentialsResponse } from "./turn";

describe("createTurnCredentialsResponse", () => {
  it("rejects anonymous requests at the public TURN route", async () => {
    const response = await SELF.fetch("https://example.com/api/turn-credentials");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "room_authorization_required" });
  });

  it("returns 503 when TURN key credentials are not configured", async () => {
    const response = await createTurnCredentialsResponse({}, vi.fn());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "turn_not_configured" });
  });

  it("mints short-lived ICE servers through the Cloudflare Realtime TURN API", async () => {
    const fetchTurnCredentials = vi.fn(async () =>
      Response.json(
        {
          iceServers: [
            { urls: ["stun:stun.cloudflare.com:3478"] },
            {
              credential: "credential-1",
              urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
              username: "username-1",
            },
          ],
        },
        { status: 201 },
      ),
    );

    const response = await createTurnCredentialsResponse(
      {
        TURN_KEY_API_TOKEN: "token-1",
        TURN_KEY_ID: "turn-key-1",
        TURN_TTL_SECONDS: "3600",
      },
      fetchTurnCredentials,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchTurnCredentials).toHaveBeenCalledWith(
      "https://rtc.live.cloudflare.com/v1/turn/keys/turn-key-1/credentials/generate-ice-servers",
      {
        body: JSON.stringify({ ttl: 3600 }),
        headers: {
          Authorization: "Bearer token-1",
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
    await expect(response.json()).resolves.toEqual({
      expiresAt: expect.any(Number),
      iceServers: [
        { urls: ["stun:stun.cloudflare.com:3478"] },
        {
          credential: "credential-1",
          urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
          username: "username-1",
        },
      ],
    });
  });

  it("falls back to a 15-minute lifetime when configuration exceeds the server maximum", async () => {
    const fetchTurnCredentials = vi.fn(async () => Response.json({ iceServers: [] }, { status: 201 }));

    await createTurnCredentialsResponse(
      {
        TURN_KEY_API_TOKEN: "token-1",
        TURN_KEY_ID: "turn-key-1",
        TURN_TTL_SECONDS: "86400",
      },
      fetchTurnCredentials,
    );

    expect(fetchTurnCredentials).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: JSON.stringify({ ttl: 900 }) }),
    );
  });
});
