import { useEffect, useMemo, useState } from "react";
import { statsRanges, type StatsRange, type StatsReport, type StatsSeriesPoint } from "../../shared/stats";
import type { Locale, Messages } from "../i18n";

type StatsLabels = Messages["stats"];

interface StatsViewProps {
  labels: StatsLabels;
  locale: Locale;
}

type StatsState =
  | { report?: undefined; status: "loading" }
  | { report?: undefined; status: "error" }
  | { report: StatsReport; status: "ready" };

export function StatsView({ labels, locale }: StatsViewProps) {
  const [range, setRange] = useState<StatsRange>("day");
  const [state, setState] = useState<StatsState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });

    fetch(`/api/stats?range=${range}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("stats unavailable");
        }

        return (await response.json()) as StatsReport;
      })
      .then((report) => setState({ report, status: "ready" }))
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        setState({ status: "error" });
      });

    return () => controller.abort();
  }, [range]);

  const cards = useMemo(() => (state.status === "ready" ? statsCards(state.report, labels, locale) : []), [labels, locale, state]);

  return (
    <section className="stats-view" aria-label={labels.label}>
      <div className="stats-head">
        <div>
          <h2>{labels.title}</h2>
          <p>{labels.subtitle}</p>
        </div>
        <div className="range-tabs" aria-label={labels.rangeLabel}>
          {statsRanges.map((option) => (
            <button
              type="button"
              className={range === option ? "primary" : "ghost"}
              key={option}
              onClick={() => setRange(option)}
            >
              {labels.ranges[option]}
            </button>
          ))}
        </div>
      </div>

      {state.status === "error" ? <p className="status-line stats-error">{labels.error}</p> : null}
      {state.status === "loading" ? <p className="status-line stats-loading">{labels.loading}</p> : null}

      {state.status === "ready" ? (
        <>
          <div className="stats-meta">
            <span>
              {labels.generated} {formatDateTime(state.report.generatedAt, locale)}
            </span>
            <span>
              {formatDateTime(state.report.window.from, locale)} - {formatDateTime(state.report.window.to, locale)}
            </span>
          </div>

          <div className="stats-card-grid">
            {cards.map((card) => (
              <article className="stats-card" key={card.label}>
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </article>
            ))}
          </div>

          <div className="stats-chart-grid">
            <StatsLineChart
              formatValue={(bytes) => formatBytes(bytes)}
              label={labels.charts.storage}
              labels={labels}
              report={state.report}
              select={(point) => point.r2.payloadBytes + point.r2.metadataBytes}
            />
            <StatsLineChart
              formatValue={(bytes) => formatBytes(bytes)}
              label={labels.charts.turn}
              labels={labels}
              report={state.report}
              select={(point) => point.turn.egressBytes}
            />
            <StatsLineChart
              formatValue={(cost) => formatCurrency(cost, locale)}
              label={labels.charts.cost}
              labels={labels}
              report={state.report}
              select={(point) => point.estimatedCostUsd}
            />
          </div>

          {state.report.warnings.length > 0 ? (
            <div className="stats-warnings">
              <strong>{labels.warnings}</strong>
              {state.report.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function statsCards(report: StatsReport, labels: StatsLabels, locale: Locale) {
  const totalStorageBytes = report.totals.r2.payloadBytes + report.totals.r2.metadataBytes;

  return [
    {
      detail: `${labels.payload}: ${formatBytes(report.totals.r2.payloadBytes)}`,
      label: labels.cards.storage,
      value: formatBytes(totalStorageBytes),
    },
    {
      detail: labels.cards.objectsDetail,
      label: labels.cards.objects,
      value: formatNumber(report.totals.r2.objectCount, locale),
    },
    {
      detail: `${labels.classA}: ${formatNumber(report.totals.r2.classARequests, locale)} / ${labels.classB}: ${formatNumber(
        report.totals.r2.classBRequests,
        locale,
      )}`,
      label: labels.cards.operations,
      value: formatNumber(report.totals.r2.classARequests + report.totals.r2.classBRequests, locale),
    },
    {
      detail: `${labels.ingress}: ${formatBytes(report.totals.turn.ingressBytes)}`,
      label: labels.cards.turnTraffic,
      value: `${labels.egress}: ${formatBytes(report.totals.turn.egressBytes)}`,
    },
    {
      detail: labels.average,
      label: labels.cards.turnConnections,
      value: formatNumber(report.totals.turn.averageConcurrentConnections, locale, 1),
    },
    {
      detail: labels.estimateDetail,
      label: labels.cards.r2Cost,
      value: formatCurrency(report.totals.r2.estimatedCostUsd, locale),
    },
    {
      detail: labels.estimateDetail,
      label: labels.cards.turnCost,
      value: formatCurrency(report.totals.turn.estimatedCostUsd, locale),
    },
    {
      detail: labels.estimateDetail,
      label: labels.cards.totalCost,
      value: formatCurrency(report.estimatedCostUsd, locale),
    },
  ];
}

function StatsLineChart({
  formatValue,
  label,
  labels,
  report,
  select,
}: {
  formatValue: (value: number) => string;
  label: string;
  labels: StatsLabels;
  report: StatsReport;
  select: (point: StatsSeriesPoint) => number;
}) {
  const values = report.series.map((point) => select(point));
  const hasData = report.series.length > 0 && values.some((value) => value > 0);
  if (!hasData) {
    return (
      <article className="stats-chart" aria-label={label}>
        <h3>{label}</h3>
        <div className="chart-empty">{labels.empty}</div>
      </article>
    );
  }

  const width = 640;
  const height = 220;
  const padding = 28;
  const max = Math.max(...values, 1);
  const points = values
    .map((value, index) => {
      const x = padding + (index / Math.max(1, values.length - 1)) * (width - padding * 2);
      const y = height - padding - (value / max) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const latestValue = values[values.length - 1] ?? 0;

  return (
    <article className="stats-chart" aria-label={label}>
      <div className="chart-title-row">
        <h3>{label}</h3>
        <span>{formatValue(latestValue)}</span>
      </div>
      <svg role="img" viewBox={`0 0 ${width} ${height}`} aria-label={label}>
        <line className="chart-axis" x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} />
        <line className="chart-axis" x1={padding} x2={padding} y1={padding} y2={height - padding} />
        <polyline className="chart-line" fill="none" points={points} />
      </svg>
    </article>
  );
}

function formatNumber(value: number, locale: Locale, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
}

function formatCurrency(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, {
    currency: "USD",
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
    style: "currency",
  }).format(value);
}

function formatDateTime(value: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
