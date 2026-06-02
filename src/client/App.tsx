import { useState } from "react";
import type { TransferProgress } from "../shared/protocol";
import { FilePicker } from "./components/FilePicker";
import { JoinRoom } from "./components/JoinRoom";
import { TransferMonitor } from "./components/TransferMonitor";
import { VerifyPhrase } from "./components/VerifyPhrase";
import { useTransferSession } from "./transfer/useTransferSession";

type Mode = "landing" | "send" | "receive";

const verificationPhrase = "amber-harbor-opal";

const seedProgress: TransferProgress = {
  transferId: "pending",
  mode: "direct-p2p",
  totalBytes: 0,
  sentBytes: 0,
  receivedBytes: 0,
  completedChunks: 0,
  totalChunks: 0,
  retryCount: 0,
  activeLanes: 0,
  spilloverBytes: 0,
};

export function App() {
  const [mode, setMode] = useState<Mode>("landing");
  const transfer = useTransferSession();
  const [code, setCode] = useState("");
  const [verified, setVerified] = useState(false);
  const fileCountLabel = `${transfer.files.length} ${transfer.files.length === 1 ? "file" : "files"} selected`;

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="product-name">Secure P2P Transfer</p>
          <h1>Send large files directly, recover cleanly when networks shift.</h1>
          <p className="lede">
            No accounts. Direct browser transfer first. Cloudflare coordinates pairing,
            NAT traversal, and short-lived encrypted recovery state.
          </p>
          <div className="actions">
            <button type="button" onClick={() => setMode("send")}>
              Send files
            </button>
            <button type="button" className="secondary" onClick={() => setMode("receive")}>
              Receive files
            </button>
          </div>
        </div>

        {mode === "send" ? (
          <section className="workflow" aria-label="Send files workflow">
            <FilePicker onFilesSelected={(files) => void transfer.selectFiles(files)} />
            <p className="file-count">{fileCountLabel}</p>
            <VerifyPhrase
              phrase={verificationPhrase}
              confirmed={verified}
              onConfirm={() => setVerified(true)}
            />
            <TransferMonitor progress={transfer.progress} />
          </section>
        ) : null}

        {mode === "receive" ? (
          <section className="workflow" aria-label="Receive files workflow">
            <JoinRoom code={code} onCodeChange={setCode} />
            <VerifyPhrase
              phrase={verificationPhrase}
              confirmed={verified}
              onConfirm={() => setVerified(true)}
            />
            <TransferMonitor progress={seedProgress} />
          </section>
        ) : null}
      </section>
    </main>
  );
}
