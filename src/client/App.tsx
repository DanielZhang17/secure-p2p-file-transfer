import { useState } from "react";
import type { TransferProgress } from "../shared/protocol";
import { FilePicker } from "./components/FilePicker";
import { JoinRoom } from "./components/JoinRoom";
import { TransferMonitor } from "./components/TransferMonitor";
import { VerifyPhrase } from "./components/VerifyPhrase";
import { createLocalVerificationPhrase } from "./transfer/crypto";
import { useTransferSession } from "./transfer/useTransferSession";

type Mode = "landing" | "send" | "receive";

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
  const [localVerificationPhrase] = useState(createLocalVerificationPhrase);
  const fileCountLabel = `${transfer.files.length} ${transfer.files.length === 1 ? "file" : "files"} selected`;
  const chooseMode = (nextMode: Mode) => {
    setMode(nextMode);
    setVerified(false);
  };

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="product-name">Secure P2P Transfer</p>
          <h1>Prepare direct browser transfers with resumable chunks.</h1>
          <p className="lede">
            No accounts. Choose sender or receiver, select files, and inspect chunk
            planning before a peer session is connected.
          </p>
          <div className="actions">
            <button type="button" onClick={() => chooseMode("send")}>
              Send files
            </button>
            <button type="button" className="secondary" onClick={() => chooseMode("receive")}>
              Receive files
            </button>
          </div>
        </div>

        {mode === "send" ? (
          <section className="workflow" aria-label="Send files workflow">
            <FilePicker onFilesSelected={(files) => void transfer.selectFiles(files)} />
            <p className="file-count">{fileCountLabel}</p>
            <VerifyPhrase
              phrase={localVerificationPhrase}
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
              phrase={localVerificationPhrase}
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
