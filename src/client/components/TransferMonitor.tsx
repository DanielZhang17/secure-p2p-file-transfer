import type { TransferProgress } from "../../shared/protocol";

export interface TransferMonitorProps {
  progress: TransferProgress;
}

export function TransferMonitor({ progress }: TransferMonitorProps) {
  const percent =
    progress.totalChunks === 0 ? 0 : Math.round((progress.completedChunks / progress.totalChunks) * 100);

  return (
    <section className="transfer-monitor" aria-label="Transfer status">
      <div>
        <span>Mode</span>
        <strong>{progress.mode}</strong>
      </div>
      <div>
        <span>Progress</span>
        <strong>{percent}%</strong>
      </div>
      <div>
        <span>Active lanes</span>
        <strong>{progress.activeLanes}</strong>
      </div>
      <div>
        <span>Retries</span>
        <strong>{progress.retryCount}</strong>
      </div>
      {progress.spilloverBytes > 0 ? <p className="warning">Encrypted recovery spillover is active.</p> : null}
    </section>
  );
}
