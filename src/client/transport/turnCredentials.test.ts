import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTurnIceServers } from "./turnCredentials";

describe("loadTurnIceServers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns ICE servers from the Worker TURN credential endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          expiresAt: Date.now() + 60_000,
          iceServers: [
            { urls: ["stun:stun.cloudflare.com:3478"] },
            { urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "p" },
          ],
        }),
      ),
    );

    await expect(loadTurnIceServers("room-ABC123", "recovery-1")).resolves.toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      { urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "p" },
    ]);
    expect(fetch).toHaveBeenCalledWith("/api/turn-credentials?roomId=room-ABC123", {
      method: "GET",
      headers: { "x-recovery-token": "recovery-1" },
    });
  });

  it("returns an empty list when TURN credentials are not configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "turn_not_configured" }, { status: 503 })));

    await expect(loadTurnIceServers("room-ABC123", "recovery-1")).resolves.toEqual([]);
  });
});
