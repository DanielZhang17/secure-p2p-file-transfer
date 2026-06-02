/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { assertRelayRequestAllowed } from "./relay";

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

  it("rejects missing content length", () => {
    expect(() => assertRelayRequestAllowed(Number.parseInt("", 10), 64 * 1024 * 1024)).toThrow(
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

describe("relay worker route", () => {
  it("echoes a small relay body", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const response = await SELF.fetch("https://example.com/api/relay", {
      method: "POST",
      headers: { "content-length": String(body.byteLength) },
      body,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
  });

  it("returns the Worker error response for oversized relay requests", async () => {
    const response = await SELF.fetch("https://example.com/api/relay", {
      method: "POST",
      headers: { "content-length": String(64 * 1024 * 1024 + 1) },
      body: new Uint8Array([1]),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
  });
});
