import { parseStatsRange, type StatsRange, type StatsReport, type StatsR2Totals, type StatsSeriesPoint, type StatsTurnTotals, type StatsWindow } from "../shared/stats";

export interface StatsEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_STATS_API_TOKEN?: string;
  STATS_DB?: D1Database;
  STATS_R2_BUCKET_NAME?: string;
  TURN_KEY_ID?: string;
}

type Fetcher = typeof fetch;

interface StatsBuildOptions {
  includeAccountMetrics?: boolean;
  now?: Date;
}

interface LiveMetrics {
  currentStorage?: R2StorageSnapshot;
  operationRows: R2OperationRow[];
  storageRows: R2StorageRow[];
  turnRows: TurnUsageRow[];
  warnings: string[];
}

interface R2OperationRow {
  actionType: string;
  requests: number;
  timestamp: string;
}

interface R2StorageRow extends R2StorageSnapshot {
  timestamp: string;
}

interface R2StorageSnapshot {
  metadataBytes: number;
  objectCount: number;
  payloadBytes: number;
}

interface TurnUsageRow {
  averageConcurrentConnections: number;
  egressBytes: number;
  ingressBytes: number;
  timestamp: string;
}

interface StoredRollupRow {
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

class StatsConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatsConfigurationError";
  }
}

class StatsProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatsProviderError";
  }
}

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const CLOUDFLARE_GRAPHQL_ENDPOINT = `${CLOUDFLARE_API_BASE}/graphql`;
const DEFAULT_BUCKET_NAME = "secure-p2p-spillover";
const DAY_MS = 86_400_000;
const BILLING_MONTH_DAYS = 30;
const BYTES_PER_BILLING_GB = 1_000_000_000;

const R2_STANDARD_STORAGE_USD_PER_GB_MONTH = 0.015;
const R2_CLASS_A_USD_PER_MILLION = 4.5;
const R2_CLASS_B_USD_PER_MILLION = 0.36;
const R2_FREE_STORAGE_GB_MONTH_PER_MONTH = 10;
const R2_FREE_CLASS_A_PER_MONTH = 1_000_000;
const R2_FREE_CLASS_B_PER_MONTH = 10_000_000;
const TURN_USD_PER_GB_EGRESS = 0.05;
const TURN_FREE_EGRESS_GB_PER_MONTH = 1_000;

const R2_CLASS_A_ACTIONS = new Set(
  [
    "ListBuckets",
    "PutBucket",
    "ListObjects",
    "PutObject",
    "CopyObject",
    "CompleteMultipartUpload",
    "CreateMultipartUpload",
    "LifecycleStorageTierTransition",
    "ListMultipartUploads",
    "UploadPart",
    "UploadPartCopy",
    "ListParts",
    "PutBucketEncryption",
    "PutBucketCors",
    "PutBucketLifecycleConfiguration",
  ].map(normalizeActionType),
);

const R2_CLASS_B_ACTIONS = new Set(
  [
    "HeadBucket",
    "HeadObject",
    "GetObject",
    "UsageSummary",
    "GetBucketEncryption",
    "GetBucketLocation",
    "GetBucketCors",
    "GetBucketLifecycleConfiguration",
  ].map(normalizeActionType),
);

const STATS_GRAPHQL_QUERY = `
query FileTransferStats(
  $accountTag: string!
  $bucketName: string!
  $startDate: Time!
  $endDate: Time!
  $startDay: Date!
  $endDay: Date!
  $turnKeyId: string
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2OperationsAdaptiveGroups(
        limit: 10000
        filter: { datetime_geq: $startDate, datetime_leq: $endDate, bucketName: $bucketName }
        orderBy: [datetime_ASC]
      ) {
        dimensions {
          actionType
          datetime
        }
        sum {
          requests
        }
      }
      r2StorageAdaptiveGroups(
        limit: 10000
        filter: { datetime_geq: $startDate, datetime_leq: $endDate, bucketName: $bucketName }
        orderBy: [datetime_ASC]
      ) {
        dimensions {
          datetime
        }
        max {
          objectCount
          payloadSize
          metadataSize
        }
      }
      callsTurnUsageAdaptiveGroups(
        limit: 10000
        filter: { date_geq: $startDay, date_leq: $endDay, keyId: $turnKeyId }
        orderBy: [datetimeFiveMinutes_ASC]
      ) {
        dimensions {
          datetimeFiveMinutes
        }
        avg {
          concurrentConnectionsFiveMinutes
        }
        sum {
          egressBytes
          ingressBytes
        }
      }
    }
  }
}
`;

export async function createStatsReportResponse(
  request: Request,
  env: StatsEnv,
  fetchCloudflare: Fetcher = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const range = parseStatsRange(url.searchParams.get("range"));

  if (!range) {
    return Response.json({ error: "invalid_range" }, { status: 400 });
  }

  try {
    const report = await buildStatsReport(range, env, fetchCloudflare, { includeAccountMetrics: false });
    return Response.json(report, {
      headers: {
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof StatsConfigurationError) {
      return Response.json({ error: "stats_not_configured" }, { status: 503 });
    }

    if (error instanceof StatsProviderError) {
      return Response.json({ error: "stats_provider_unavailable" }, { status: 502 });
    }

    throw error;
  }
}

export async function captureStatsRollup(
  env: StatsEnv,
  fetchCloudflare: Fetcher = fetch,
  now: Date = new Date(),
): Promise<void> {
  if (!env.STATS_DB) {
    throw new StatsConfigurationError("STATS_DB is required");
  }

  const dayStart = startOfUtcDay(now);
  const dayEnd = new Date(Math.min(dayStart.getTime() + DAY_MS - 1, now.getTime()));
  const window: StatsWindow = {
    from: dayStart.toISOString(),
    to: dayEnd.toISOString(),
    grain: "hour",
  };
  const live = await fetchLiveMetrics(env, fetchCloudflare, window, true);
  const report = reportFromLiveMetrics("day", window, new Date(), live);
  await writeStatsRollup(env.STATS_DB, report, utcDateKey(dayStart));
}

export async function buildStatsReport(
  range: StatsRange,
  env: StatsEnv,
  fetchCloudflare: Fetcher = fetch,
  options: StatsBuildOptions = {},
): Promise<StatsReport> {
  const now = options.now ?? new Date();
  if (range === "day" || range === "month") {
    const window = statsWindowForRange(range, now);
    const live = await fetchLiveMetrics(env, fetchCloudflare, window, options.includeAccountMetrics === true);
    return reportFromLiveMetrics(range, window, now, live);
  }

  if (!env.STATS_DB) {
    throw new StatsConfigurationError("STATS_DB is required for stored stats ranges");
  }

  const storedRows = await readStoredRollups(env.STATS_DB, range === "year" ? utcDateKey(startOfUtcYear(now)) : undefined);
  const currentWindow = {
    from: startOfUtcDay(now).toISOString(),
    to: now.toISOString(),
    grain: "hour" as const,
  };
  const live = await fetchLiveMetrics(env, fetchCloudflare, currentWindow, options.includeAccountMetrics === true);
  const current = reportFromLiveMetrics("day", currentWindow, now, live);
  const combined = combineStoredRollups(range, now, storedRows, current);

  if (storedRows.length === 0) {
    combined.warnings.push("Stored daily rollups start from this feature deployment; no older historical backfill is available.");
  }

  combined.warnings.push(...live.warnings);
  return combined;
}

function statsWindowForRange(range: "day" | "month", now: Date): StatsWindow {
  if (range === "day") {
    return {
      from: new Date(now.getTime() - DAY_MS).toISOString(),
      to: now.toISOString(),
      grain: "hour",
    };
  }

  return {
    from: new Date(now.getTime() - 30 * DAY_MS).toISOString(),
    to: now.toISOString(),
    grain: "day",
  };
}

async function fetchLiveMetrics(
  env: StatsEnv,
  fetchCloudflare: Fetcher,
  window: StatsWindow,
  includeAccountMetrics: boolean,
): Promise<LiveMetrics> {
  assertCloudflareStatsConfigured(env);

  const [graphqlBody, currentStorage] = await Promise.all([
    fetchCloudflareGraphql(env, fetchCloudflare, window),
    includeAccountMetrics ? fetchCurrentR2AccountMetrics(env, fetchCloudflare) : Promise.resolve(undefined),
  ]);
  const accounts = readAccounts(graphqlBody);
  const account = accounts[0];
  if (!account) {
    throw new StatsProviderError("Cloudflare GraphQL response did not include account stats");
  }

  return {
    currentStorage,
    operationRows: parseR2OperationRows(readArray(account, "r2OperationsAdaptiveGroups")),
    storageRows: parseR2StorageRows(readArray(account, "r2StorageAdaptiveGroups")),
    turnRows: parseTurnRows(readArray(account, "callsTurnUsageAdaptiveGroups")),
    warnings:
      includeAccountMetrics && !currentStorage
        ? ["Current R2 account metrics were unavailable; using GraphQL bucket analytics only."]
        : [],
  };
}

async function fetchCloudflareGraphql(env: StatsEnv, fetchCloudflare: Fetcher, window: StatsWindow): Promise<unknown> {
  const response = await fetchCloudflare(CLOUDFLARE_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_STATS_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: STATS_GRAPHQL_QUERY,
      variables: {
        accountTag: env.CLOUDFLARE_ACCOUNT_ID,
        bucketName: env.STATS_R2_BUCKET_NAME ?? DEFAULT_BUCKET_NAME,
        endDate: window.to,
        endDay: utcDateKey(new Date(window.to)),
        startDate: window.from,
        startDay: utcDateKey(new Date(window.from)),
        turnKeyId: env.TURN_KEY_ID ?? "",
      },
    }),
  });

  if (!response.ok) {
    throw new StatsProviderError("Cloudflare GraphQL request failed");
  }

  const body: unknown = await response.json();
  if (hasCloudflareErrors(body)) {
    throw new StatsProviderError("Cloudflare GraphQL response contained errors");
  }

  return body;
}

async function fetchCurrentR2AccountMetrics(
  env: StatsEnv,
  fetchCloudflare: Fetcher,
): Promise<R2StorageSnapshot | undefined> {
  const response = await fetchCloudflare(
    `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID ?? "")}/r2/metrics`,
    {
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_STATS_API_TOKEN}`,
      },
      method: "GET",
    },
  );

  if (!response.ok) {
    return undefined;
  }

  const body: unknown = await response.json();
  return parseCurrentR2Storage(body);
}

function reportFromLiveMetrics(
  range: StatsRange,
  window: StatsWindow,
  now: Date,
  metrics: LiveMetrics,
): StatsReport {
  const series = buildLiveSeries(window, metrics);
  if (series.length === 0 && metrics.currentStorage) {
    series.push(emptySeriesPoint(bucketTimestamp(now, window.grain), window));
    const current = series[series.length - 1];
    current.r2.payloadBytes = metrics.currentStorage.payloadBytes;
    current.r2.metadataBytes = metrics.currentStorage.metadataBytes;
    current.r2.objectCount = metrics.currentStorage.objectCount;
  }

  return finishReport(range, window, now, series, [
    "Cost estimates use public pricing, simple proration, and monthly free-tier assumptions; they are not invoice totals.",
    ...metrics.warnings,
  ]);
}

function buildLiveSeries(window: StatsWindow, metrics: LiveMetrics): StatsSeriesPoint[] {
  const points = new Map<string, StatsSeriesPoint>();

  for (const row of metrics.storageRows) {
    const key = bucketTimestamp(new Date(row.timestamp), window.grain);
    const point = ensureSeriesPoint(points, key, window);
    point.r2.payloadBytes = Math.max(point.r2.payloadBytes, row.payloadBytes);
    point.r2.metadataBytes = Math.max(point.r2.metadataBytes, row.metadataBytes);
    point.r2.objectCount = Math.max(point.r2.objectCount, row.objectCount);
  }

  for (const row of metrics.operationRows) {
    const key = bucketTimestamp(new Date(row.timestamp), window.grain);
    const point = ensureSeriesPoint(points, key, window);
    const className = classifyR2Action(row.actionType);
    if (className === "A") {
      point.r2.classARequests += row.requests;
    } else if (className === "B") {
      point.r2.classBRequests += row.requests;
    } else if (className === "unknown") {
      point.r2.classARequests += row.requests;
    }
  }

  const turnConnectionCounts = new Map<string, { count: number; total: number }>();
  for (const row of metrics.turnRows) {
    const key = bucketTimestamp(new Date(row.timestamp), window.grain);
    const point = ensureSeriesPoint(points, key, window);
    point.turn.egressBytes += row.egressBytes;
    point.turn.ingressBytes += row.ingressBytes;
    const aggregate = turnConnectionCounts.get(key) ?? { count: 0, total: 0 };
    aggregate.count += 1;
    aggregate.total += row.averageConcurrentConnections;
    turnConnectionCounts.set(key, aggregate);
  }

  for (const [key, aggregate] of turnConnectionCounts) {
    const point = points.get(key);
    if (point) {
      point.turn.averageConcurrentConnections = aggregate.count > 0 ? aggregate.total / aggregate.count : 0;
    }
  }

  return [...points.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function finishReport(
  range: StatsRange,
  window: StatsWindow,
  now: Date,
  series: StatsSeriesPoint[],
  warnings: string[],
): StatsReport {
  const totals = aggregateSeries(series);
  const costs = estimateCosts(totals.r2, totals.turn, window);
  totals.r2.estimatedCostUsd = costs.r2;
  totals.turn.estimatedCostUsd = costs.turn;

  for (const point of series) {
    const pointWindow = pointWindowForCost(point.timestamp, window.grain);
    const pointCosts = estimateCosts(point.r2, point.turn, pointWindow);
    point.r2.estimatedCostUsd = pointCosts.r2;
    point.turn.estimatedCostUsd = pointCosts.turn;
    point.estimatedCostUsd = pointCosts.combined;
  }

  return {
    estimatedCostUsd: costs.combined,
    estimatedCostsUsd: costs,
    generatedAt: now.toISOString(),
    range,
    series,
    totals,
    warnings: [...new Set(warnings)],
    window,
  };
}

function aggregateSeries(series: StatsSeriesPoint[]): { r2: StatsR2Totals; turn: StatsTurnTotals } {
  const r2 = emptyR2Totals();
  const turn = emptyTurnTotals();
  let latestStorage: StatsSeriesPoint | undefined;
  let turnConnectionPoints = 0;

  for (const point of series) {
    r2.classARequests += point.r2.classARequests;
    r2.classBRequests += point.r2.classBRequests;
    turn.egressBytes += point.turn.egressBytes;
    turn.ingressBytes += point.turn.ingressBytes;
    if (point.turn.averageConcurrentConnections > 0) {
      turn.averageConcurrentConnections += point.turn.averageConcurrentConnections;
      turnConnectionPoints += 1;
    }

    if (point.r2.payloadBytes > 0 || point.r2.metadataBytes > 0 || point.r2.objectCount > 0) {
      latestStorage = point;
    }
  }

  if (latestStorage) {
    r2.metadataBytes = latestStorage.r2.metadataBytes;
    r2.objectCount = latestStorage.r2.objectCount;
    r2.payloadBytes = latestStorage.r2.payloadBytes;
  }

  if (turnConnectionPoints > 0) {
    turn.averageConcurrentConnections /= turnConnectionPoints;
  }

  return { r2, turn };
}

function estimateCosts(r2: StatsR2Totals, turn: StatsTurnTotals, window: StatsWindow) {
  const windowDays = Math.max(1 / 24, (new Date(window.to).getTime() - new Date(window.from).getTime()) / DAY_MS);
  const freeTierMonths = windowDays / BILLING_MONTH_DAYS;
  const storedGb = (r2.payloadBytes + r2.metadataBytes) / BYTES_PER_BILLING_GB;
  const storageGbMonth = storedGb * freeTierMonths;
  const billableStorageGbMonth = Math.max(0, storageGbMonth - R2_FREE_STORAGE_GB_MONTH_PER_MONTH * freeTierMonths);
  const billableClassA = Math.max(0, r2.classARequests - R2_FREE_CLASS_A_PER_MONTH * freeTierMonths);
  const billableClassB = Math.max(0, r2.classBRequests - R2_FREE_CLASS_B_PER_MONTH * freeTierMonths);
  const billableTurnEgressGb = Math.max(
    0,
    turn.egressBytes / BYTES_PER_BILLING_GB - TURN_FREE_EGRESS_GB_PER_MONTH * freeTierMonths,
  );
  const r2Cost =
    billableStorageGbMonth * R2_STANDARD_STORAGE_USD_PER_GB_MONTH +
    (billableClassA / 1_000_000) * R2_CLASS_A_USD_PER_MILLION +
    (billableClassB / 1_000_000) * R2_CLASS_B_USD_PER_MILLION;
  const turnCost = billableTurnEgressGb * TURN_USD_PER_GB_EGRESS;

  return {
    combined: roundUsd(r2Cost + turnCost),
    r2: roundUsd(r2Cost),
    turn: roundUsd(turnCost),
  };
}

async function readStoredRollups(db: D1Database, fromDate?: string): Promise<StoredRollupRow[]> {
  const statement = fromDate
    ? db.prepare("SELECT * FROM stats_daily_rollups WHERE date >= ? ORDER BY date ASC").bind(fromDate)
    : db.prepare("SELECT * FROM stats_daily_rollups ORDER BY date ASC").bind();
  const result = await statement.all<StoredRollupRow>();
  return result.results ?? [];
}

async function writeStatsRollup(db: D1Database, report: StatsReport, date: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO stats_daily_rollups (
        date,
        captured_at,
        r2_payload_bytes,
        r2_metadata_bytes,
        r2_object_count,
        r2_class_a_requests,
        r2_class_b_requests,
        turn_ingress_bytes,
        turn_egress_bytes,
        turn_average_concurrent_connections,
        estimated_r2_cost_usd,
        estimated_turn_cost_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        captured_at = excluded.captured_at,
        r2_payload_bytes = excluded.r2_payload_bytes,
        r2_metadata_bytes = excluded.r2_metadata_bytes,
        r2_object_count = excluded.r2_object_count,
        r2_class_a_requests = excluded.r2_class_a_requests,
        r2_class_b_requests = excluded.r2_class_b_requests,
        turn_ingress_bytes = excluded.turn_ingress_bytes,
        turn_egress_bytes = excluded.turn_egress_bytes,
        turn_average_concurrent_connections = excluded.turn_average_concurrent_connections,
        estimated_r2_cost_usd = excluded.estimated_r2_cost_usd,
        estimated_turn_cost_usd = excluded.estimated_turn_cost_usd`,
    )
    .bind(
      date,
      report.generatedAt,
      report.totals.r2.payloadBytes,
      report.totals.r2.metadataBytes,
      report.totals.r2.objectCount,
      report.totals.r2.classARequests,
      report.totals.r2.classBRequests,
      report.totals.turn.ingressBytes,
      report.totals.turn.egressBytes,
      report.totals.turn.averageConcurrentConnections,
      report.totals.r2.estimatedCostUsd,
      report.totals.turn.estimatedCostUsd,
    )
    .run();
}

function combineStoredRollups(
  range: "year" | "all",
  now: Date,
  storedRows: StoredRollupRow[],
  current: StatsReport,
): StatsReport {
  const points = storedRows.map(seriesPointFromStoredRollup);
  const currentDate = utcDateKey(now);
  const withoutCurrentDay = points.filter((point) => utcDateKey(new Date(point.timestamp)) !== currentDate);
  const currentDayPoint = collapseReportToDailyPoint(current, startOfUtcDay(now));
  const series = [...withoutCurrentDay, currentDayPoint].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const firstTimestamp = series[0]?.timestamp ?? startOfUtcDay(now).toISOString();
  const window: StatsWindow = {
    from: range === "year" ? startOfUtcYear(now).toISOString() : firstTimestamp,
    to: now.toISOString(),
    grain: "day",
  };

  return finishReport(range, window, now, series, [
    "Cost estimates use public pricing, simple proration, and monthly free-tier assumptions; they are not invoice totals.",
  ]);
}

function collapseReportToDailyPoint(report: StatsReport, date: Date): StatsSeriesPoint {
  return {
    estimatedCostUsd: report.estimatedCostUsd,
    r2: { ...report.totals.r2 },
    timestamp: date.toISOString(),
    turn: { ...report.totals.turn },
  };
}

function seriesPointFromStoredRollup(row: StoredRollupRow): StatsSeriesPoint {
  return {
    estimatedCostUsd: roundUsd(row.estimated_r2_cost_usd + row.estimated_turn_cost_usd),
    r2: {
      classARequests: row.r2_class_a_requests,
      classBRequests: row.r2_class_b_requests,
      estimatedCostUsd: row.estimated_r2_cost_usd,
      metadataBytes: row.r2_metadata_bytes,
      objectCount: row.r2_object_count,
      payloadBytes: row.r2_payload_bytes,
    },
    timestamp: `${row.date}T00:00:00.000Z`,
    turn: {
      averageConcurrentConnections: row.turn_average_concurrent_connections,
      egressBytes: row.turn_egress_bytes,
      estimatedCostUsd: row.estimated_turn_cost_usd,
      ingressBytes: row.turn_ingress_bytes,
    },
  };
}

function parseR2OperationRows(rows: unknown[]): R2OperationRow[] {
  return rows.flatMap((row) => {
    const dimensions = readObject(row, "dimensions");
    const sum = readObject(row, "sum");
    const timestamp = readString(dimensions, "datetime");
    const actionType = readString(dimensions, "actionType");
    if (!timestamp || !actionType) {
      return [];
    }

    return [
      {
        actionType,
        requests: readNumber(sum, "requests"),
        timestamp,
      },
    ];
  });
}

function parseR2StorageRows(rows: unknown[]): R2StorageRow[] {
  return rows.flatMap((row) => {
    const dimensions = readObject(row, "dimensions");
    const max = readObject(row, "max");
    const timestamp = readString(dimensions, "datetime");
    if (!timestamp) {
      return [];
    }

    return [
      {
        metadataBytes: readNumber(max, "metadataSize"),
        objectCount: readNumber(max, "objectCount"),
        payloadBytes: readNumber(max, "payloadSize"),
        timestamp,
      },
    ];
  });
}

function parseTurnRows(rows: unknown[]): TurnUsageRow[] {
  return rows.flatMap((row) => {
    const dimensions = readObject(row, "dimensions");
    const avg = readObject(row, "avg");
    const sum = readObject(row, "sum");
    const timestamp = readString(dimensions, "datetimeFiveMinutes") ?? readString(dimensions, "datetimeHour");
    if (!timestamp) {
      return [];
    }

    return [
      {
        averageConcurrentConnections:
          readNumber(avg, "concurrentConnectionsFiveMinutes") || readNumber(avg, "concurrentConnectionsHour"),
        egressBytes: readNumber(sum, "egressBytes"),
        ingressBytes: readNumber(sum, "ingressBytes"),
        timestamp,
      },
    ];
  });
}

function parseCurrentR2Storage(body: unknown): R2StorageSnapshot | undefined {
  const result = readObject(body, "result");
  const standard = readObject(result, "standard");
  const published = readObject(standard, "published");
  if (!published) {
    return undefined;
  }

  return {
    metadataBytes: readNumber(published, "metadataSize"),
    objectCount: readNumber(published, "objects"),
    payloadBytes: readNumber(published, "payloadSize"),
  };
}

function readAccounts(body: unknown): unknown[] {
  const data = readObject(body, "data");
  const viewer = readObject(data, "viewer");
  return readArray(viewer, "accounts");
}

function hasCloudflareErrors(body: unknown): boolean {
  return readArray(body, "errors").length > 0;
}

function readObject(parent: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof parent !== "object" || parent === null || !(key in parent)) {
    return undefined;
  }

  const value = (parent as Record<string, unknown>)[key];
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function readArray(parent: unknown, key: string): unknown[] {
  if (typeof parent !== "object" || parent === null || !(key in parent)) {
    return [];
  }

  const value = (parent as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

function readString(parent: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = parent?.[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(parent: Record<string, unknown> | undefined, key: string): number {
  const value = parent?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function assertCloudflareStatsConfigured(env: StatsEnv): void {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_STATS_API_TOKEN) {
    throw new StatsConfigurationError("Cloudflare account and stats token are required");
  }
}

function ensureSeriesPoint(points: Map<string, StatsSeriesPoint>, timestamp: string, window: StatsWindow): StatsSeriesPoint {
  const existing = points.get(timestamp);
  if (existing) {
    return existing;
  }

  const point = emptySeriesPoint(timestamp, window);
  points.set(timestamp, point);
  return point;
}

function emptySeriesPoint(timestamp: string, _window: StatsWindow): StatsSeriesPoint {
  return {
    estimatedCostUsd: 0,
    r2: emptyR2Totals(),
    timestamp,
    turn: emptyTurnTotals(),
  };
}

function emptyR2Totals(): StatsR2Totals {
  return {
    classARequests: 0,
    classBRequests: 0,
    estimatedCostUsd: 0,
    metadataBytes: 0,
    objectCount: 0,
    payloadBytes: 0,
  };
}

function emptyTurnTotals(): StatsTurnTotals {
  return {
    averageConcurrentConnections: 0,
    egressBytes: 0,
    estimatedCostUsd: 0,
    ingressBytes: 0,
  };
}

function classifyR2Action(actionType: string): "A" | "B" | "free" | "unknown" {
  const normalized = normalizeActionType(actionType);
  if (R2_CLASS_A_ACTIONS.has(normalized)) {
    return "A";
  }

  if (R2_CLASS_B_ACTIONS.has(normalized)) {
    return "B";
  }

  if (normalized === "deleteobject" || normalized === "deletebucket" || normalized === "abortmultipartupload") {
    return "free";
  }

  return "unknown";
}

function normalizeActionType(actionType: string): string {
  return actionType.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function bucketTimestamp(date: Date, grain: "hour" | "day"): string {
  if (grain === "hour") {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours())).toISOString();
  }

  return startOfUtcDay(date).toISOString();
}

function pointWindowForCost(timestamp: string, grain: "hour" | "day"): StatsWindow {
  const from = new Date(timestamp);
  const to = new Date(from.getTime() + (grain === "hour" ? DAY_MS / 24 : DAY_MS));
  return {
    from: from.toISOString(),
    grain,
    to: to.toISOString(),
  };
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcYear(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function roundUsd(value: number): number {
  return Math.round(value * 10000) / 10000;
}
