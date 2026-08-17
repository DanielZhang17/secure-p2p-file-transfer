import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TransferProgress } from "../../shared/protocol";
import { TransferMonitor } from "./TransferMonitor";

describe("TransferMonitor", () => {
  it("shows real-time transfer speed", () => {
    render(<TransferMonitor progress={createProgress({ speedBytesPerSecond: 2_097_152 })} />);

    expect(screen.getByText("Speed")).toBeInTheDocument();
    expect(screen.getByText("2.0 MB/s")).toBeInTheDocument();
  });

  it("shows the selected TURN route and address family", () => {
    render(<TransferMonitor progress={createProgress({ mode: "turn-relay", addressFamily: "ipv4" })} />);

    expect(screen.getByText("TURN relay · IPv4")).toBeInTheDocument();
  });

  it("does not claim a route before ICE selects one", () => {
    render(<TransferMonitor progress={createProgress({ mode: "negotiating", addressFamily: "unknown" })} />);

    expect(screen.getByText("Detecting route")).toBeInTheDocument();
  });
});

function createProgress(overrides: Partial<TransferProgress> = {}): TransferProgress {
  return {
    transferId: "transfer-1",
    mode: "direct-p2p",
    addressFamily: "ipv6",
    totalBytes: 1024,
    sentBytes: 512,
    receivedBytes: 0,
    completedChunks: 1,
    totalChunks: 2,
    retryCount: 0,
    activeLanes: 1,
    spilloverBytes: 0,
    speedBytesPerSecond: 0,
    ...overrides,
  };
}
