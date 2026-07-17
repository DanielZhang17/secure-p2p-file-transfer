/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { captureStatsRollup, createStatsReportResponse, type StatsEnv } from "./stats";

describe("stats worker", () => {
  it("rejects invalid stats ranges through the public route", async () => {
    const response = await SELF.fetch("https://example.com/api/stats?range=week");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_range" });
  });

  it("returns sanitized totals from mocked Cloudflare metrics", async () => {
    const response = await createStatsReportResponse(
      new Request("https://example.com/api/stats?range=day"),
      statsEnv(),
      createCloudflareStatsFetch({
        classARequests: 7,
        classBRequests: 11,
        objectCount: 3,
        payloadBytes: 1_000,
        turnEgressBytes: 400,
        turnIngressBytes: 300,
      }),
    );
    const body = (await response.json()) as {
      range: string;
      totals: {
        r2: { classARequests: number; classBRequests: number; objectCount: number; payloadBytes: number };
        turn: { egressBytes: number; ingressBytes: number };
      };
    };

    expect(response.status).toBe(200);
    expect(body.range).toBe("day");
    expect(body.totals.r2).toMatchObject({
      classARequests: 7,
      classBRequests: 11,
      objectCount: 3,
      payloadBytes: 1_000,
    });
    expect(body.totals.turn).toMatchObject({
      egressBytes: 400,
      ingressBytes: 300,
    });
  });

  it("returns a safe provider error when Cloudflare metrics fail", async () => {
    const fetchCloudflare = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/graphql")) {
        return new Response("unavailable", { status: 500 });
      }

      return Response.json({ success: true, result: { standard: { published: {} } } });
    }) as unknown as typeof fetch;

    const response = await createStatsReportResponse(
      new Request("https://example.com/api/stats?range=month"),
      statsEnv(),
      fetchCloudflare,
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "stats_provider_unavailable" });
  });

  it("writes scheduled daily rollups idempotently", async () => {
    const db = new FakeStatsDatabase();
    const env = statsEnv({ STATS_DB: db as unknown as D1Database });

    await captureStatsRollup(
      env,
      createCloudflareStatsFetch({ classARequests: 2, objectCount: 1, payloadBytes: 128 }),
      new Date("2026-06-07T12:00:00.000Z"),
    );
    await captureStatsRollup(
      env,
      createCloudflareStatsFetch({ classARequests: 5, objectCount: 4, payloadBytes: 2_048 }),
      new Date("2026-06-07T18:00:00.000Z"),
    );

    expect(db.rows.size).toBe(1);
    expect(db.rows.get("2026-06-07")).toMatchObject({
      date: "2026-06-07",
      r2_class_a_requests: 5,
      r2_object_count: 4,
      r2_payload_bytes: 2_048,
    });
  });
});

function statsEnv(overrides: Partial<StatsEnv> = {}): StatsEnv {
  return {
    CLOUDFLARE_ACCOUNT_ID: "8ed2bc59fe8a84a9696c3ab792512a3c",
    CLOUDFLARE_STATS_API_TOKEN: "stats-token",
    STATS_R2_BUCKET_NAME: "secure-p2p-spillover",
    TURN_KEY_ID: "turn-key-1",
    ...overrides,
  };
}

function createCloudflareStatsFetch({
  classARequests = 0,
  classBRequests = 0,
  objectCount = 0,
  payloadBytes = 0,
  turnEgressBytes = 0,
  turnIngressBytes = 0,
}: {
  classARequests?: number;
  classBRequests?: number;
  objectCount?: number;
  payloadBytes?: number;
  turnEgressBytes?: number;
  turnIngressBytes?: number;
}): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/graphql")) {
      return Response.json({
        data: {
          viewer: {
            accounts: [
              {
                callsTurnUsageAdaptiveGroups: [
                  {
                    avg: { concurrentConnectionsFiveMinutes: 2 },
                    dimensions: { datetimeFiveMinutes: "2026-06-07T01:00:00Z" },
                    sum: { egressBytes: turnEgressBytes, ingressBytes: turnIngressBytes },
                  },
                ],
                r2OperationsAdaptiveGroups: [
                  {
                    dimensions: { actionType: "PutObject", datetime: "2026-06-07T01:10:00Z" },
                    sum: { requests: classARequests },
                  },
                  {
                    dimensions: { actionType: "GetObject", datetime: "2026-06-07T01:20:00Z" },
                    sum: { requests: classBRequests },
                  },
                ],
                r2StorageAdaptiveGroups: [
                  {
                    dimensions: { datetime: "2026-06-07T01:00:00Z" },
                    max: { metadataSize: 12, objectCount, payloadSize: payloadBytes },
                  },
                ],
              },
            ],
          },
        },
      });
    }

    return Response.json({
      result: {
        standard: {
          published: {
            metadataSize: 12,
            objects: objectCount,
            payloadSize: payloadBytes,
          },
        },
      },
      success: true,
    });
  }) as unknown as typeof fetch;
}

interface FakeRollupRow {
  captured_at: string;
  date: string;
  estimated_r2_cost_usd: number;
  estimated_turn_cost_usd: number;
  r2_class_a_requests: number;
  r2_class_b_requests: number;
  r2_metadata_bytes: number;
  r2_object_count: number;
  r2_payload_bytes: number;
  turn_average_concurrent_connections: number;
  turn_egress_bytes: number;
  turn_ingress_bytes: number;
}

class FakeStatsDatabase {
  readonly rows = new Map<string, FakeRollupRow>();

  prepare(query: string) {
    return new FakeStatsStatement(this, query);
  }
}

class FakeStatsStatement {
  private params: unknown[] = [];

  constructor(private readonly db: FakeStatsDatabase, private readonly query: string) {}

  bind(...params: unknown[]) {
    this.params = params;
    return this;
  }

  async all<T>() {
    const fromDate = typeof this.params[0] === "string" ? this.params[0] : undefined;
    const rows = [...this.db.rows.values()].filter((row) => !fromDate || row.date >= fromDate);
    return { results: rows as T[], success: true };
  }

  async run() {
    if (!this.query.includes("INSERT INTO stats_daily_rollups")) {
      return { success: true };
    }

    const [
      date,
      capturedAt,
      r2PayloadBytes,
      r2MetadataBytes,
      r2ObjectCount,
      r2ClassARequests,
      r2ClassBRequests,
      turnIngressBytes,
      turnEgressBytes,
      turnAverageConcurrentConnections,
      estimatedR2CostUsd,
      estimatedTurnCostUsd,
    ] = this.params;

    this.db.rows.set(String(date), {
      captured_at: String(capturedAt),
      date: String(date),
      estimated_r2_cost_usd: Number(estimatedR2CostUsd),
      estimated_turn_cost_usd: Number(estimatedTurnCostUsd),
      r2_class_a_requests: Number(r2ClassARequests),
      r2_class_b_requests: Number(r2ClassBRequests),
      r2_metadata_bytes: Number(r2MetadataBytes),
      r2_object_count: Number(r2ObjectCount),
      r2_payload_bytes: Number(r2PayloadBytes),
      turn_average_concurrent_connections: Number(turnAverageConcurrentConnections),
      turn_egress_bytes: Number(turnEgressBytes),
      turn_ingress_bytes: Number(turnIngressBytes),
    });

    return { success: true };
  }
}
