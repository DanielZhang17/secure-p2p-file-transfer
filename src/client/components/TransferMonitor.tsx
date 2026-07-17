import type { TransferProgress } from "../../shared/protocol";

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
}

const defaultLabels: TransferMonitorLabels = {
  activeLanes: "Active lanes",
  label: "Transfer status",
  mode: "Mode",
  progress: "Progress",
  retries: "Retries",
  speed: "Speed",
  spillover: "Encrypted recovery spillover is active.",
};

export function TransferMonitor({ labels = defaultLabels, progress }: TransferMonitorProps) {
  const percent =
    progress.totalChunks === 0 ? 0 : Math.round((progress.completedChunks / progress.totalChunks) * 100);

  return (
    <section className="transfer-monitor" aria-label={labels.label}>
      <div>
        <span>{labels.mode}</span>
        <strong>{progress.mode}</strong>
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
