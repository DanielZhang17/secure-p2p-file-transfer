import { useEffect, useState, type CSSProperties } from "react";
import type { FileManifest, TransferProgress } from "../shared/protocol";
import { FilePicker } from "./components/FilePicker";
import { JoinRoom } from "./components/JoinRoom";
import { StatsView } from "./components/StatsView";
import { formatTransferRoute, TransferMonitor } from "./components/TransferMonitor";
import { VerifyPhrase } from "./components/VerifyPhrase";
import {
  languageStorageKey,
  localeOptions,
  messages,
  resolveLanguagePreference,
  resolveLocaleFromLanguages,
  type LanguagePreference,
  type Locale,
  type Messages,
} from "./i18n";
import { saveReceivedFile } from "./transfer/receivedFileSave";
import type { PairingState } from "./transfer/usePairingSession";
import { usePairingSession } from "./transfer/usePairingSession";
import { usePeerTransfer, type TransferIntegrityStatus } from "./transfer/usePeerTransfer";
import { useTransferSession } from "./transfer/useTransferSession";

type Mode = "landing" | "send" | "receive" | "stats";

const seedProgress: TransferProgress = {
  transferId: "pending",
  mode: "negotiating",
  addressFamily: "unknown",
  totalBytes: 0,
  sentBytes: 0,
  receivedBytes: 0,
  completedChunks: 0,
  totalChunks: 0,
  retryCount: 0,
  activeLanes: 0,
  spilloverBytes: 0,
  speedBytesPerSecond: 0,
};

export function App() {
  const [mode, setMode] = useState<Mode>("landing");
  const [code, setCode] = useState("");
  const [languagePreference, setLanguagePreference] = useState<LanguagePreference>(() =>
    resolveLanguagePreference(localStorage.getItem(languageStorageKey)),
  );
  const [autoLocale, setAutoLocale] = useState<Locale>(() => browserLocale());
  const locale = languagePreference === "auto" ? autoLocale : languagePreference;
  const pairing = usePairingSession();
  const t = messages[locale];
  const transfer = useTransferSession({ recoveryToken: pairing.state.recoveryToken, roomId: pairing.state.roomId });
  const peerTransfer = usePeerTransfer({
    expiresAt: pairing.state.expiresAt,
    files: transfer.files,
    manifests: transfer.manifests,
    onServerMessage: pairing.onServerMessage,
    pairingStatus: pairing.state.status,
    recoveryToken: pairing.state.recoveryToken,
    role: pairing.state.role,
    roomId: pairing.state.roomId,
    sendRoomMessage: pairing.sendRoomMessage,
  });

  const fileCountLabel = formatFileCount(transfer.files.length, locale, t);
  const needsFileReselection = mode === "send" && transfer.files.length === 0 && transfer.manifests.length > 0;
  const hasPeerProgress =
    peerTransfer.status !== "idle" || peerTransfer.progress.transferId !== "pending";
  const displayedProgress = hasPeerProgress
    ? peerTransfer.progress
    : mode === "send"
      ? transfer.progress
      : seedProgress;
  const workspaceLocked = mode === "landing";

  const chooseMode = (nextMode: Exclude<Mode, "stats">) => {
    pairing.resetPairing();
    setMode(nextMode);
    if (nextMode === "send") {
      void pairing.startSenderRoom();
    }
  };

  useEffect(() => {
    localStorage.setItem(languageStorageKey, languagePreference);
    document.documentElement.lang = locale;
  }, [languagePreference, locale]);

  useEffect(() => {
    if (languagePreference !== "auto" || typeof window === "undefined") {
      return;
    }

    const updateAutoLocale = () => setAutoLocale(browserLocale());
    window.addEventListener("languagechange", updateAutoLocale);
    updateAutoLocale();

    return () => window.removeEventListener("languagechange", updateAutoLocale);
  }, [languagePreference]);

  useEffect(() => {
    if (mode !== "landing" || !pairing.state.role || pairing.state.status === "idle") {
      return;
    }

    setMode(pairing.state.role === "sender" ? "send" : "receive");
  }, [mode, pairing.state.role, pairing.state.status]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="mark">FT</span>
          <span>{t.appName}</span>
        </div>
        <div className="topbar-actions">
          <div className="system-pill">
            <span className={`dot ${pairing.state.status === "connected" ? "ok" : ""}`} />
            <span>{topbarStatus(pairing.state, peerTransfer.status, t)}</span>
          </div>
          <button type="button" className={mode === "stats" ? "primary nav-button" : "ghost nav-button"} onClick={() => setMode("stats")}>
            {t.stats.nav}
          </button>
          <label className="language-select">
            <span>{t.language}</span>
            <select
              aria-label="Language"
              value={languagePreference}
              onChange={(event) => setLanguagePreference(resolveLanguagePreference(event.currentTarget.value))}
            >
              <option value="auto">{t.autoLanguage}</option>
              {localeOptions.map((option) => (
                <option key={option.locale} value={option.locale}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <section className="hero" aria-label={t.hero.region}>
        <div className="intro">
          <p className="product-name">{t.hero.eyebrow}</p>
          <h1>{t.hero.title}</h1>
          <p className="lede">{t.hero.lede}</p>

          <div className="actions" aria-label={t.hero.chooseRole}>
            <button type="button" className={mode === "send" ? "primary" : undefined} onClick={() => chooseMode("send")}>
              {t.hero.send}
            </button>
            <button
              type="button"
              className={mode === "receive" ? "primary" : "secondary"}
              onClick={() => chooseMode("receive")}
            >
              {t.hero.receive}
            </button>
          </div>

          <div className="stepper" aria-label={t.hero.sequence}>
            {t.hero.steps.map(([title, copy], index) => (
              <Step key={title} number={index + 1} title={title} copy={copy} />
            ))}
          </div>
        </div>

        <article className="panel pair-card" aria-label={t.pairing.gate}>
          <div className="pair-head">
            <div>
              <h2>{t.pairing.title}</h2>
              <p>{t.pairing.copy}</p>
            </div>
            <StatusBadge pairing={pairing.state} t={t} />
          </div>

          <PairingCard
            pairing={pairing.state}
            t={t}
            verificationConfirmed={peerTransfer.verificationConfirmed}
            verificationPhrase={peerTransfer.verificationPhrase}
            onConfirmVerification={peerTransfer.confirmVerificationPhrase}
          />

          {mode === "landing" ? <p className="hint">{t.pairing.hint}</p> : null}

          {mode === "receive" ? (
            <form
              className="peer-form"
              onSubmit={(event) => {
                event.preventDefault();
                pairing.joinRecipientRoom(code);
              }}
            >
              <JoinRoom code={code} label={t.joinRoom.code} onCodeChange={setCode} />
              <button type="submit" className="primary">
                {t.pairing.join}
              </button>
            </form>
          ) : null}

          {mode === "send" && pairing.state.code ? (
            <button type="button" className="secondary" onClick={() => void copyPairingCode(pairing.state.code)}>
              {t.pairing.copyCode}
            </button>
          ) : null}

          <div className="checks" aria-label={t.pairing.checksLabel}>
            <Check title={t.pairing.checks[0][0]} copy={t.pairing.checks[0][1]} />
            <Check
              title={t.pairing.checks[1][0]}
              copy={displayedProgress.mode === "recovery-relay" ? t.pairing.checks[1][2] : t.pairing.checks[1][1]}
            />
            <Check
              title={t.pairing.checks[2][0]}
              copy={pairing.state.expiresAt ? t.pairing.checks[2][2] : t.pairing.checks[2][1]}
            />
          </div>
        </article>
      </section>

      {mode === "stats" ? (
        <StatsView labels={t.stats} locale={locale} />
      ) : (
      <section className={`workspace${workspaceLocked ? " locked" : " unlocked"}`} aria-label={t.workspace.label}>
        <div className="workspace-head">
          <div>
            <h2>{t.workspace.title}</h2>
            <p className="hint">{t.workspace.source}</p>
            <div className="source-path">
              {mode === "send" ? `${t.workspace.senderQueue}: ${fileCountLabel}` : t.workspace.browserState}
            </div>
          </div>
          {mode !== "landing" ? (
            <button type="button" className="ghost" onClick={() => chooseMode("landing")}>
              {t.workspace.reset}
            </button>
          ) : null}
        </div>

        <Telemetry progress={displayedProgress} t={t} />

        <section className="transfer-grid">
          <div className="panel transfer-panel">
            {mode === "send" ? (
              <>
                <FilePicker
                  labels={{
                    choose: t.filePicker.choose,
                    copy: t.filePicker.copy,
                    dropZone: t.filePicker.dropZone,
                    title: t.filePicker.title,
                  }}
                  onFilesSelected={(files) => void transfer.selectFiles(files)}
                />
                <p className="file-count">{fileCountLabel}</p>
                {needsFileReselection ? <p className="status-line">{t.filePicker.reselect}</p> : null}
                <TransferQueue
                  files={transfer.files}
                  manifests={transfer.manifests}
                  needsFileReselection={needsFileReselection}
                  progress={displayedProgress}
                  t={t}
                />
                {peerTransfer.canSend ? (
                  <button type="button" className="primary send-button" onClick={() => void peerTransfer.sendSelectedFiles()}>
                    {t.filePicker.sendSelected}
                  </button>
                ) : null}
              </>
            ) : (
              <LockedDrop mode={mode} t={t} />
            )}
          </div>

          <aside className="side-stack">
            {mode === "receive" ? (
              <article className="module receive-request">
                <div className="sender">
                  <div className="avatar">RX</div>
                  <div>
                    <h3>{t.peer.incoming}</h3>
                    <p>{receiverStatusText(peerTransfer.status, t)}</p>
                  </div>
                </div>
                {peerTransfer.canChooseReceiveDirectory ? (
                  <button type="button" className="secondary" onClick={() => void peerTransfer.chooseReceiveDirectory()}>
                    {peerTransfer.receiveDirectoryReady ? t.peer.saveFolderReady : t.peer.chooseSaveFolder}
                  </button>
                ) : null}
              </article>
            ) : null}

            <PeerTransferCard status={peerTransfer.status} receivedFiles={peerTransfer.receivedFiles} t={t} />
            <PeerHealth
              integrityStatus={peerTransfer.integrityStatus}
              pairing={pairing.state}
              progress={displayedProgress}
              status={peerTransfer.status}
              t={t}
            />
          </aside>
        </section>
      </section>
      )}
    </main>
  );
}

function Step({ copy, number, title }: { copy: string; number: number; title: string }) {
  return (
    <div className="step">
      <b>{number}</b>
      <div>
        <strong>{title}</strong>
        <span>{copy}</span>
      </div>
    </div>
  );
}

function Check({ copy, title }: { copy: string; title: string }) {
  return (
    <div className="check">
      <b>{title}</b>
      <span>{copy}</span>
    </div>
  );
}

function StatusBadge({ pairing, t }: { pairing: PairingState; t: Messages }) {
  const connected = pairing.status === "connected";
  return (
    <div className={`status${connected ? " connected" : ""}`}>
      <span className="dot" />
      <span>{connected ? t.pairing.statuses.connected : pairing.status === "idle" ? t.pairing.statuses.waiting : t.pairing.statuses.connecting}</span>
    </div>
  );
}

function PeerTransferCard({
  receivedFiles,
  status,
  t,
}: {
  receivedFiles: Array<{ file?: File; name: string; savedToDisk?: boolean; size: number; url?: string }>;
  status: string;
  t: Messages;
}) {
  if (status === "idle" && receivedFiles.length === 0) {
    return null;
  }

  return (
    <section className="module" aria-label={t.peer.transfer}>
      <h3>{t.peer.transfer}</h3>
      <p className="status-line">{transferStatusMessage(status, t)}</p>
      {receivedFiles.length > 0 ? (
        <div className="received-files">
          {receivedFiles.map(({ file, name, savedToDisk, size, url }) => (
            <div className="received-file" key={`${name}:${size}:${savedToDisk ? "disk" : "blob"}`}>
              <strong>{name}</strong>
              {savedToDisk ? <span className="saved-disk">{t.peer.savedToDisk}</span> : null}
              {file && url ? (
                <div className="received-actions">
                  <button type="button" onClick={() => void saveReceivedFile({ file, url })}>
                    {t.peer.saveFile}
                  </button>
                  <a href={url} download={name}>
                    {t.peer.downloadFile}
                  </a>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function transferStatusMessage(status: string, t: Messages): string {
  if (status === "ready") {
    return t.peer.statuses.ready;
  }

  if (status === "transferring") {
    return t.peer.statuses.transferring;
  }

  if (status === "complete") {
    return t.peer.statuses.complete;
  }

  if (status === "error") {
    return t.peer.statuses.error;
  }

  return t.peer.statuses.connecting;
}

function PairingCard({
  onConfirmVerification,
  pairing,
  t,
  verificationConfirmed,
  verificationPhrase,
}: {
  onConfirmVerification: () => void;
  pairing: PairingState;
  t: Messages;
  verificationConfirmed: boolean;
  verificationPhrase?: string;
}) {
  const now = useCountdownNow(pairing.expiresAt);

  if (pairing.status === "idle") {
    return null;
  }

  return (
    <section className="pairing-card" aria-label={t.pairing.status}>
      <span>{t.pairing.status}</span>
      {pairing.code ? <strong className="pairing-code">{pairing.code}</strong> : null}
      {verificationPhrase ? (
        <VerifyPhrase
          confirmed={verificationConfirmed}
          phrase={verificationPhrase}
          labels={t.verify}
          onConfirm={onConfirmVerification}
        />
      ) : null}
      {pairing.role === "sender" && pairing.code ? <p>{t.pairing.shareCode}</p> : null}
      <p className="status-line">{pairingStatusLine(pairing, t)}</p>
      {pairing.expiresAt ? <small>{t.pairing.expiresIn} {formatExpiryCountdown(pairing.expiresAt, now)}</small> : null}
    </section>
  );
}

function Telemetry({ progress, t }: { progress: TransferProgress; t: Messages }) {
  return (
    <section className="telemetry" aria-label={t.telemetry.label}>
      <Metric label={t.telemetry.speed} value={formatBytesPerSecond(progress.speedBytesPerSecond)} />
      <Metric label={t.telemetry.eta} value={formatEta(progress, t)} />
      <Metric label={t.telemetry.progress} value={`${formatProgressPercent(progress)}%`} />
      <Metric label={t.telemetry.retries} value={String(progress.retryCount)} />
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function TransferQueue({
  files,
  manifests,
  needsFileReselection,
  progress,
  t,
}: {
  files: File[];
  manifests: FileManifest[];
  needsFileReselection: boolean;
  progress: TransferProgress;
  t: Messages;
}) {
  const percent = formatProgressPercent(progress);
  const rows =
    files.length > 0
      ? files.map((file, index) => ({
          chunks: manifests[index]?.chunkCount ?? 0,
          key: `${file.name}:${file.lastModified}:${file.size}`,
          name: file.name,
          size: formatBytes(file.size),
        }))
      : manifests.map((manifest) => ({
          chunks: manifest.chunkCount,
          key: manifest.fileId,
          name: manifest.name,
          size: formatBytes(manifest.size),
        }));

  if (rows.length === 0) {
    return (
      <div className="queue empty">
        <p>{t.filePicker.empty}</p>
      </div>
    );
  }

  return (
    <div className="queue" aria-label={t.queue.label}>
      {rows.map((row) => (
        <article className="file-row" key={row.key}>
          <div>
            <strong>{row.name}</strong>
            <small>
              {row.size} · {row.chunks} {t.queue.chunks}
            </small>
            <div className="bar">
              <span style={{ "--p": `${needsFileReselection ? 0 : percent}%` } as CSSProperties} />
            </div>
          </div>
          <div>
            <div className="speed-cell">{formatBytesPerSecond(progress.speedBytesPerSecond)}</div>
            <div className="state-cell">{queueState(progress, needsFileReselection, t)}</div>
          </div>
        </article>
      ))}
    </div>
  );
}

function LockedDrop({ mode, t }: { mode: Mode; t: Messages }) {
  return (
    <div className="file-picker locked-drop" aria-label={t.lockedDrop.label}>
      <span className="file-picker-title">
        {mode === "receive" ? t.lockedDrop.receiveTitle : t.lockedDrop.landingTitle}
      </span>
      <span className="file-picker-copy">
        {mode === "receive" ? t.lockedDrop.receiveCopy : t.lockedDrop.landingCopy}
      </span>
    </div>
  );
}

function PeerHealth({
  integrityStatus,
  pairing,
  progress,
  status,
  t,
}: {
  integrityStatus: TransferIntegrityStatus;
  pairing: PairingState;
  progress: TransferProgress;
  status: string;
  t: Messages;
}) {
  return (
    <article className="module">
      <h3>{t.peer.health}</h3>
      <div className="mini-list">
        <div>
          <span>{t.peer.connection}</span>
          <strong>{status === "idle" ? pairing.status : status}</strong>
        </div>
        <div>
          <span>{t.peer.transport}</span>
          <strong>{formatTransferRoute(progress, t.monitor)}</strong>
        </div>
        <div>
          <span>{t.peer.activeLanes}</span>
          <strong>{progress.activeLanes}</strong>
        </div>
        <div>
          <span>{t.peer.integrity}</span>
          <strong className={`integrity-state ${integrityStatus}`}>{integrityStatusText(integrityStatus, t)}</strong>
        </div>
        <div>
          <span>{t.peer.recovery}</span>
          <strong>{pairing.recoveryToken ? t.peer.tokenReady : t.peer.notStarted}</strong>
        </div>
      </div>
      <TransferMonitor progress={progress} labels={t.monitor} />
    </article>
  );
}

function topbarStatus(pairing: PairingState, peerStatus: string, t: Messages): string {
  if (peerStatus === "transferring") {
    return t.system.transferActive;
  }

  if (peerStatus === "complete") {
    return t.system.transferComplete;
  }

  if (pairing.status === "connected") {
    return t.system.roomConnected;
  }

  return t.system.auto;
}

function integrityStatusText(status: TransferIntegrityStatus, t: Messages): string {
  return t.peer.integrityStatuses[status];
}

function receiverStatusText(status: string, t: Messages): string {
  if (status === "transferring") {
    return t.peer.receiver.transferring;
  }

  if (status === "complete") {
    return t.peer.receiver.complete;
  }

  return t.peer.receiver.idle;
}

function pairingStatusLine(pairing: PairingState, t: Messages): string {
  if (pairing.message === "Creating pairing room.") {
    return t.pairing.messages.creating;
  }

  if (pairing.message === "Opening pairing room.") {
    return t.pairing.messages.opening;
  }

  if (pairing.message === "Restoring pairing room.") {
    return t.pairing.messages.restoring;
  }

  if (pairing.message === "Waiting for receiver.") {
    return t.pairing.messages.waitingForReceiver;
  }

  if (pairing.message === "Waiting for sender.") {
    return t.pairing.messages.waitingForSender;
  }

  if (pairing.message === "Sender connected.") {
    return t.pairing.messages.senderConnected;
  }

  if (pairing.message === "Receiver connected.") {
    return t.pairing.messages.receiverConnected;
  }

  if (pairing.message === "Pairing connection dropped. Reconnecting.") {
    return t.pairing.messages.connectionDropped;
  }

  if (pairing.message === "Pairing connection disrupted. Reconnecting.") {
    return t.pairing.messages.connectionDisrupted;
  }

  if (pairing.message === "Pairing connection failed.") {
    return t.pairing.messages.connectionFailed;
  }

  if (pairing.message === "Pairing connection closed.") {
    return t.pairing.messages.connectionClosed;
  }

  if (pairing.message === "Could not create a pairing room.") {
    return t.pairing.messages.createFailed;
  }

  if (pairing.message === "Enter the 6-character pairing code.") {
    return t.pairing.messages.enterCode;
  }

  if (pairing.message === "Pairing code is invalid.") {
    return t.pairing.messages.invalidCode;
  }

  if (pairing.message === "Pairing room expired. Create a new code.") {
    return t.pairing.messages.roomExpired;
  }

  if (pairing.message === "Pairing room error.") {
    return t.pairing.messages.roomError;
  }

  return pairing.message;
}

function queueState(progress: TransferProgress, needsFileReselection: boolean, t: Messages): string {
  if (needsFileReselection) {
    return t.queue.states.reselect;
  }

  if (progress.totalChunks > 0 && progress.completedChunks >= progress.totalChunks) {
    return t.queue.states.complete;
  }

  if (progress.completedChunks > 0) {
    return t.queue.states.sending;
  }

  return t.queue.states.queued;
}

function formatFileCount(count: number, locale: Locale, t: Messages): string {
  const noun = count === 1 ? t.filePicker.file : t.filePicker.files;

  if (locale === "zh-CN") {
    return `${t.filePicker.selected}${count}${noun}`;
  }

  if (locale === "ja") {
    return `${count}${noun}${t.filePicker.selected}`;
  }

  return `${count} ${noun} ${t.filePicker.selected}`;
}

function formatProgressPercent(progress: TransferProgress): number {
  if (progress.totalChunks === 0) {
    return 0;
  }

  return Math.min(100, Math.round((progress.completedChunks / progress.totalChunks) * 100));
}

function formatEta(progress: TransferProgress, t: Messages): string {
  const transferred = Math.max(progress.sentBytes, progress.receivedBytes);
  const remaining = Math.max(0, progress.totalBytes - transferred);
  if (progress.totalBytes === 0) {
    return t.telemetry.waiting;
  }

  if (remaining === 0 || progress.completedChunks >= progress.totalChunks) {
    return t.telemetry.complete;
  }

  if (progress.speedBytesPerSecond <= 0) {
    return t.telemetry.settling;
  }

  return formatDuration(Math.ceil(remaining / progress.speedBytesPerSecond));
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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

function formatBytesPerSecond(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

async function copyPairingCode(code: string): Promise<void> {
  await navigator.clipboard?.writeText(code);
}

function browserLocale(): Locale {
  if (typeof navigator === "undefined") {
    return "en";
  }

  const languages = Array.isArray(navigator.languages) ? navigator.languages : [];
  return resolveLocaleFromLanguages(languages.length > 0 ? languages : navigator.language);
}

function useCountdownNow(expiresAt?: number): number {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!expiresAt) {
      return;
    }

    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  return now;
}

function formatExpiryCountdown(expiresAt: number, now: number): string {
  const remainingSeconds = Math.max(1, Math.ceil((expiresAt - now) / 1000));
  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = remainingSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }

  return `${seconds}s`;
}
