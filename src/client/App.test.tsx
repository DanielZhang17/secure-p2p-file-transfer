import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { StatsRange, StatsReport } from "../shared/stats";
import {
  acceptTransferMessage,
  createChunkAck,
  createIncomingTransferState,
  createTransferKeyExchangeMessage,
  hasSentTransferKeyExchange,
  parseDataChannelTransferMessage,
} from "./transfer/dataChannelTransfer";
import { languageStorageKey } from "./i18n";

describe("App", () => {
  beforeEach(() => {
    localStorage.removeItem("secure-p2p-transfer:pairing-session");
    localStorage.removeItem("secure-p2p-transfer:outgoing-manifests");
    localStorage.removeItem(languageStorageKey);
    setNavigatorLanguages(["en-US"], "en-US");
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    FakeRTCPeerConnection.instances.length = 0;
    FakeWebSocket.instances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    document.documentElement.lang = "en";
    vi.unstubAllGlobals();
  });

  it("shows sender and recipient entry points", () => {
    render(<App />);

    expect(screen.getByRole("button", { name: "Send files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Receive files" })).toBeInTheDocument();
    expect(screen.queryByText("amber-harbor-opal")).not.toBeInTheDocument();
  });

  it("describes the current pairing preparation state honestly", () => {
    render(<App />);

    expect(screen.getByRole("heading", { level: 1, name: "Pair. Send. Resume." })).toBeInTheDocument();
    expect(screen.queryByText(/Prepare direct browser transfers/)).not.toBeInTheDocument();
    expect(screen.queryByText(/NAT traversal/)).not.toBeInTheDocument();
    expect(screen.queryByText(/shared phrase/)).not.toBeInTheDocument();
  });

  it("switches the interface language", async () => {
    render(<App />);

    await userEvent.selectOptions(screen.getByLabelText("Language"), "zh-CN");

    expect(screen.getByRole("heading", { level: 1, name: "配对。发送。续传。" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送文件" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("auto-detects the interface language from browser preferences", () => {
    setNavigatorLanguages(["es-MX", "en-US"], "en-US");

    render(<App />);

    expect(screen.getByRole("heading", { level: 1, name: "Empareja. Envía. Reanuda." })).toBeInTheDocument();
    expect(screen.getByLabelText("Language")).toHaveValue("auto");
    expect(localStorage.getItem(languageStorageKey)).toBe("auto");
    expect(document.documentElement.lang).toBe("es");
  });

  it("keeps a manual language selection instead of following browser preferences", async () => {
    setNavigatorLanguages(["es-MX", "en-US"], "en-US");

    render(<App />);
    await userEvent.selectOptions(screen.getByLabelText("Language"), "ja");

    cleanup();
    setNavigatorLanguages(["zh-CN"], "zh-CN");
    render(<App />);

    expect(screen.getByRole("heading", { level: 1, name: "ペア。送信。再開。" })).toBeInTheDocument();
    expect(screen.getByLabelText("Language")).toHaveValue("ja");
    expect(localStorage.getItem(languageStorageKey)).toBe("ja");
    expect(document.documentElement.lang).toBe("ja");
  });

  it("shows runtime integrity status without stale spec gaps", () => {
    render(<App />);

    expect(screen.getByText("Integrity")).toBeInTheDocument();
    expect(screen.queryByText("Implementation gaps")).not.toBeInTheDocument();
    expect(screen.queryByText(/Recipient refresh progress rehydration/)).not.toBeInTheDocument();
    expect(screen.queryByText(/TURN credential issuance/)).not.toBeInTheDocument();
  });

  it("shows the public stats view with cards and charts", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(Response.json(mockStatsReport("day")));

    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Stats" }));

    expect(await screen.findByRole("heading", { level: 2, name: "Stats" })).toBeInTheDocument();
    expect(screen.getByText("R2 storage")).toBeInTheDocument();
    expect(screen.getByText("TURN traffic")).toBeInTheDocument();
    expect(screen.getByText("Combined estimate")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "R2 storage over time" })).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/stats?range=day");
  });

  it("fetches the selected stats range", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(Response.json(mockStatsReport("day")));
    fetchMock.mockResolvedValueOnce(Response.json(mockStatsReport("month")));

    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Stats" }));
    await screen.findByText("R2 operations");

    await userEvent.click(screen.getByRole("button", { name: "Month" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/stats?range=month");
    });
  });

  it("renders stats loading and empty graph states", async () => {
    const fetchMock = vi.mocked(fetch);
    let resolveStats: (response: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveStats = resolve;
      }),
    );

    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Stats" }));

    expect(screen.getByText("Loading stats.")).toBeInTheDocument();

    resolveStats(Response.json(mockStatsReport("day", [])));

    expect(await screen.findAllByText("No usage data for this range yet.")).toHaveLength(3);
  });

  it("shows pairing code input when receiving files", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Receive files" }));

    expect(screen.getByLabelText("Pairing code")).toBeInTheDocument();
  });

  it("lets receivers choose a streaming save folder when the browser supports it", async () => {
    vi.stubGlobal(
      "showDirectoryPicker",
      vi.fn(async () => ({
        getFileHandle: vi.fn(),
      })),
    );
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Receive files" }));
    await userEvent.click(screen.getByRole("button", { name: "Choose save folder" }));

    expect(screen.getByRole("button", { name: "Save folder ready" })).toBeInTheDocument();
  });

  it("shows file picker and starts selected file count at zero when sending files", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Send files" }));

    expect(screen.getByLabelText("Choose files")).toBeInTheDocument();
    expect(screen.getByText("0 files selected")).toBeInTheDocument();
  });

  it("creates a room and shows the sender pairing code", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        roomId: "room-ABCD23",
        code: "ABCD23",
        expiresAt: Date.now() + 86_400_000,
      }),
    );

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Send files" }));

    expect(await screen.findByText("ABCD23")).toBeInTheDocument();
    expect(screen.getByText("Share this code with the receiver.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/rooms", { method: "POST" });
    expect(FakeWebSocket.instances[0]?.url).toBe("ws://localhost:3000/api/rooms/room-ABCD23?code=ABCD23");
    await waitFor(() => {
      expect(FakeWebSocket.instances[0]?.sent).toContain('{"type":"join","role":"sender"}');
    });
  });

  it("shows room expiry as a live countdown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        roomId: "room-ABCD23",
        code: "ABCD23",
        expiresAt: Date.now() + 86_400_000,
      }),
    );

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send files" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Expires in 24h 00m 00s")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(screen.getByText("Expires in 23h 59m 59s")).toBeInTheDocument();
  });

  it("joins a room with the entered pairing code", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Receive files" }));
    await userEvent.type(screen.getByLabelText("Pairing code"), "abcd23");
    await userEvent.click(screen.getByRole("button", { name: "Join room" }));

    expect(FakeWebSocket.instances[0]?.url).toBe("ws://localhost:3000/api/rooms/room-ABCD23?code=ABCD23");
    await waitFor(() => {
      expect(FakeWebSocket.instances[0]?.sent).toContain('{"type":"join","role":"recipient"}');
    });
    FakeWebSocket.instances[0]?.dispatchMessage({
      type: "joined",
      roomId: "room-ABCD23",
      role: "recipient",
      recoveryToken: "recovery-1",
      expiresAt: Date.now() + 86_400_000,
    });
    expect(await screen.findByText("Waiting for sender.")).toBeInTheDocument();
  });

  it("sends the selected file over an open peer data channel", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        roomId: "room-ABCD23",
        code: "ABCD23",
        expiresAt: Date.now() + 86_400_000,
      }),
    );
    const file = new File(["hello peer"], "hello.txt", { type: "text/plain" });

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Send files" }));
    const roomSocket = FakeWebSocket.instances[0];
    roomSocket?.dispatchMessage({
      type: "joined",
      roomId: "room-ABCD23",
      role: "sender",
      recoveryToken: "recovery-1",
      expiresAt: Date.now() + 86_400_000,
    });
    roomSocket?.dispatchMessage({ type: "peer-joined", role: "recipient" });
    await userEvent.upload(screen.getByLabelText("Choose files"), file);
    await waitFor(() => {
      expect(FakeRTCPeerConnection.instances[0]?.dataChannel).toBeDefined();
    });
    FakeRTCPeerConnection.instances[0]?.dataChannel?.open();

    await userEvent.click(await screen.findByRole("button", { name: "The phrases match" }));

    await userEvent.click(await screen.findByRole("button", { name: "Send selected files" }));

    await waitFor(() => {
      const sentMessages = FakeRTCPeerConnection.instances[0]?.dataChannel?.sent.map((payload) => JSON.parse(payload));
      expect(sentMessages?.map((message) => message.type)).toEqual([
        "key-exchange",
        "verification-confirmed",
        "manifest",
        "chunk-frame",
      ]);
    });
    const chunkFrameMessage = FakeRTCPeerConnection.instances[0]?.dataChannel?.sent
      .map((payload) => parseDataChannelTransferMessage(payload))
      .find((message) => message?.type === "chunk-frame");
    if (!chunkFrameMessage || chunkFrameMessage.type !== "chunk-frame") {
      throw new Error("expected encrypted chunk frame");
    }
    const ack = await createChunkAck({
      type: "chunk",
      transferId: chunkFrameMessage.transferId,
      fileId: chunkFrameMessage.fileId,
      chunkIndex: chunkFrameMessage.chunkIndex,
      ivBase64: chunkFrameMessage.ivBase64,
      ciphertextBase64: chunkFrameMessage.ciphertextBase64,
    });
    await act(async () => {
      roomSocket?.dispatchMessage({ type: "ack", ack });
    });

    const transferCheckPhrase = await screen.findByLabelText("Transfer check phrase");
    expect(screen.getByLabelText("Pairing status")).toContainElement(transferCheckPhrase);
    expect(screen.queryByRole("button", { name: "Mark checked" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Checked" })).not.toBeInTheDocument();
    expect(await screen.findByText("Transfer complete.")).toBeInTheDocument();
  });

  it("reconnects the pairing socket with the recovery token after an unexpected close", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        roomId: "room-ABCD23",
        code: "ABCD23",
        expiresAt: Date.now() + 86_400_000,
      }),
    );

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Send files" }));
    const roomSocket = FakeWebSocket.instances[0];
    roomSocket?.dispatchMessage({
      type: "joined",
      roomId: "room-ABCD23",
      role: "sender",
      recoveryToken: "recovery-1",
      expiresAt: Date.now() + 86_400_000,
    });

    vi.useFakeTimers();
    act(() => {
      roomSocket?.close();
    });
    expect(screen.getByText("Pairing connection dropped. Reconnecting.")).toBeInTheDocument();

    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]?.sent).toContain('{"type":"join","role":"sender","recoveryToken":"recovery-1"}');
    vi.useRealTimers();
  });

  it("restores a joined sender room after page refresh", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        roomId: "room-ABCD23",
        code: "ABCD23",
        expiresAt: Date.now() + 86_400_000,
      }),
    );

    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Send files" }));
    FakeWebSocket.instances[0]?.dispatchMessage({
      type: "joined",
      roomId: "room-ABCD23",
      role: "sender",
      recoveryToken: "recovery-1",
      expiresAt: Date.now() + 86_400_000,
    });
    expect(await screen.findByText("Waiting for receiver.")).toBeInTheDocument();

    cleanup();
    FakeWebSocket.instances.length = 0;
    render(<App />);

    expect(await screen.findByText("ABCD23")).toBeInTheDocument();
    expect(screen.getByLabelText("Choose files")).toBeInTheDocument();
    await waitFor(() => {
      expect(FakeWebSocket.instances[0]?.sent).toContain(
        '{"type":"join","role":"sender","recoveryToken":"recovery-1"}',
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not show the transfer check phrase before key exchange", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Send files" }));
    expect(screen.queryByLabelText("Local check phrase")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Transfer check phrase")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Receive files" }));

    expect(screen.queryByLabelText("Local check phrase")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Transfer check phrase")).not.toBeInTheDocument();
  });
});

function mockStatsReport(range: StatsRange, series = [mockStatsPoint()]): StatsReport {
  return {
    estimatedCostUsd: 0.01,
    estimatedCostsUsd: { combined: 0.01, r2: 0, turn: 0.01 },
    generatedAt: "2026-06-07T00:00:00.000Z",
    range,
    series,
    totals: {
      r2: {
        classARequests: 12,
        classBRequests: 34,
        estimatedCostUsd: 0,
        metadataBytes: 512,
        objectCount: 3,
        payloadBytes: 1_048_576,
      },
      turn: {
        averageConcurrentConnections: 2,
        egressBytes: 2_097_152,
        estimatedCostUsd: 0.01,
        ingressBytes: 1_048_576,
      },
    },
    warnings: ["Cost estimates are approximate."],
    window: {
      from: "2026-06-06T00:00:00.000Z",
      grain: range === "day" ? "hour" : "day",
      to: "2026-06-07T00:00:00.000Z",
    },
  };
}

function mockStatsPoint(): StatsReport["series"][number] {
  return {
    estimatedCostUsd: 0.01,
    r2: {
      classARequests: 12,
      classBRequests: 34,
      estimatedCostUsd: 0,
      metadataBytes: 512,
      objectCount: 3,
      payloadBytes: 1_048_576,
    },
    timestamp: "2026-06-07T00:00:00.000Z",
    turn: {
      averageConcurrentConnections: 2,
      egressBytes: 2_097_152,
      estimatedCostUsd: 0.01,
      ingressBytes: 1_048_576,
    },
  };
}

function setNavigatorLanguages(languages: string[], language: string): void {
  Object.defineProperty(navigator, "languages", { configurable: true, value: languages });
  Object.defineProperty(navigator, "language", { configurable: true, value: language });
}

class FakeWebSocket extends EventTarget {
  static readonly CLOSED = 3;
  static readonly CLOSING = 2;
  static readonly CONNECTING = 0;
  static readonly instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  readonly sent: string[] = [];
  readyState: number = WebSocket.CONNECTING;

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close"));
  }

  dispatchMessage(message: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  send(payload: string): void {
    this.sent.push(payload);
  }
}

class FakeDataChannel extends EventTarget {
  private readonly peerState = createIncomingTransferState();
  readonly sent: string[] = [];
  readyState: RTCDataChannelState = "connecting";

  constructor(readonly label: string) {
    super();
  }

  close(): void {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }

  open(): void {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  send(payload: string): void {
    this.sent.push(payload);
    void this.replyToKeyExchange(payload);
  }

  private async replyToKeyExchange(payload: string): Promise<void> {
    const message = parseDataChannelTransferMessage(payload);
    if (!message) {
      return;
    }
    if (message.type === "verification-confirmed") {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
      return;
    }
    if (message.type !== "key-exchange") {
      return;
    }

    const shouldReply = !hasSentTransferKeyExchange(this.peerState, message.transferId);
    const reply = shouldReply ? await createTransferKeyExchangeMessage(this.peerState, message.transferId) : undefined;
    await acceptTransferMessage(this.peerState, message);
    if (reply) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(reply) }));
    }
  }
}

class FakeRTCPeerConnection extends EventTarget {
  static readonly instances: FakeRTCPeerConnection[] = [];
  dataChannel?: FakeDataChannel;
  localDescription: RTCSessionDescriptionInit | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;

  constructor() {
    super();
    FakeRTCPeerConnection.instances.push(this);
  }

  addIceCandidate(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {}

  createAnswer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: "answer", sdp: "answer-sdp" });
  }

  createDataChannel(label: string): FakeDataChannel {
    this.dataChannel = new FakeDataChannel(label);
    return this.dataChannel;
  }

  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: "offer", sdp: "offer-sdp" });
  }

  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
    return Promise.resolve();
  }

  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
    return Promise.resolve();
  }
}
