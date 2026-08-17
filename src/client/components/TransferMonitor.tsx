import type { TransferAddressFamily, TransferMode, TransferProgress } from "../../shared/protocol";

export interface TransferMonitorProps {
  labels?: TransferMonitorLabels;
  progress: TransferProgress;
}

export interface TransferMonitorLabels {
  activeLanes: string;
  label: string;
  mode: string;
  progress: string;
  retries: string;
  speed: string;
  spillover: string;
  modes: Record<TransferMode, string>;
  addressFamilies: Record<Exclude<TransferAddressFamily, "unknown">, string>;
}

const defaultLabels: TransferMonitorLabels = {
  activeLanes: "Active lanes",
  label: "Transfer status",
  mode: "Mode",
  progress: "Progress",
  retries: "Retries",
  speed: "Speed",
  spillover: "Encrypted recovery spillover is active.",
  modes: {
    negotiating: "Detecting route",
    "direct-p2p": "Direct P2P",
    "turn-relay": "TURN relay",
    "recovery-relay": "Recovery relay",
  },
  addressFamilies: { ipv4: "IPv4", ipv6: "IPv6" },
};

export function TransferMonitor({ labels = defaultLabels, progress }: TransferMonitorProps) {
  const percent =
    progress.totalChunks === 0 ? 0 : Math.round((progress.completedChunks / progress.totalChunks) * 100);

  return (
    <section className="transfer-monitor" aria-label={labels.label}>
      <div>
        <span>{labels.mode}</span>
        <strong>{formatTransferRoute(progress, labels)}</strong>
      </div>
      <div>
        <span>{labels.progress}</span>
        <strong>{percent}%</strong>
      </div>
      <div>
        <span>{labels.speed}</span>
        <strong>{formatBytesPerSecond(progress.speedBytesPerSecond)}</strong>
      </div>
      <div>
        <span>{labels.activeLanes}</span>
        <strong>{progress.activeLanes}</strong>
      </div>
      <div>
        <span>{labels.retries}</span>
        <strong>{progress.retryCount}</strong>
      </div>
      {progress.spilloverBytes > 0 ? <p className="warning">{labels.spillover}</p> : null}
    </section>
  );
}

export function formatTransferRoute(progress: TransferProgress, labels: TransferMonitorLabels): string {
  const mode = labels.modes[progress.mode];
  if (
    progress.addressFamily === "unknown"
    || progress.mode === "negotiating"
    || progress.mode === "recovery-relay"
  ) {
    return mode;
  }

  return `${mode} · ${labels.addressFamilies[progress.addressFamily]}`;
}

function formatBytesPerSecond(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return "0 B/s";
  }

  if (bytesPerSecond >= 1024 * 1024) {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  }

  if (bytesPerSecond >= 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  }

  return `${Math.round(bytesPerSecond)} B/s`;
}
