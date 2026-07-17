export const statsRanges = ["day", "month", "year", "all"] as const;

export type StatsRange = (typeof statsRanges)[number];
export type StatsGrain = "hour" | "day";

export interface StatsWindow {
  from: string;
  to: string;
  grain: StatsGrain;
}

export interface StatsR2Totals {
  payloadBytes: number;
  metadataBytes: number;
  objectCount: number;
  classARequests: number;
  classBRequests: number;
  estimatedCostUsd: number;
}

export interface StatsTurnTotals {
  ingressBytes: number;
  egressBytes: number;
  averageConcurrentConnections: number;
  estimatedCostUsd: number;
}

export interface StatsCostTotals {
  r2: number;
  turn: number;
  combined: number;
}

export interface StatsSeriesPoint {
  timestamp: string;
  r2: StatsR2Totals;
  turn: StatsTurnTotals;
  estimatedCostUsd: number;
}

export interface StatsReport {
  range: StatsRange;
  generatedAt: string;
  window: StatsWindow;
  totals: {
    r2: StatsR2Totals;
    turn: StatsTurnTotals;
  };
  estimatedCostUsd: number;
  estimatedCostsUsd: StatsCostTotals;
  series: StatsSeriesPoint[];
  warnings: string[];
}

export function parseStatsRange(value: string | null): StatsRange | null {
  if (!value) {
    return "day";
  }

  return statsRanges.includes(value as StatsRange) ? (value as StatsRange) : null;
}
