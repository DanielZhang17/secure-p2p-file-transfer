import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileManifest, ServerRoomMessage } from "../../shared/protocol";
import { saveChunkAckProgress } from "./ackProgress";
import {
  acceptTransferMessage,
  createChunkAck,
  createEncryptedChunkMessage,
  createIncomingTransferState,
  createManifestMessage,
  createTransferKeyExchangeMessage,
  createTransferMessages,
  getTransferContentKey,
  parseDataChannelTransferMessage,
} from "./dataChannelTransfer";
import { loadReceivedFile } from "./receivedChunkStore";
import { saveReceivedManifest } from "./receivedManifestStore";
import { usePeerTransfer } from "./usePeerTransfer";

describe("usePeerTransfer", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "turn_not_configured" }, { status: 503 })));
    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
    FakeRTCPeerConnection.instances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    return deleteProgressDb();
  });

  it("tracks recipient progress from incoming manifests and decrypted chunks", async () => {
    let serverListener: ((message: ServerRoomMessage) => void) | undefined;
    const input = {
      files: [],
      manifests: [],
      onServerMessage: (listener: (message: ServerRoomMessage) => void) => {
        serverListener = listener;
        return () => {
          serverListener = undefined;
        };
      },
      pairingStatus: "connected",
      role: "recipient" as const,
      sendRoomMessage: vi.fn(),
    };
    const file = new File(["hello world"], "hello.txt", { type: "text/plain", lastModified: 1_700_000_000_000 });
    const manifest: FileManifest = {
      transferId: "transfer-1",
      fileId: "file-1",
      name: "hello.txt",
      size: file.size,
      type: "text/plain",
      lastModified: file.lastModified,
      chunkSize: 6,
      chunkCount: 2,
    };
    const senderState = createIncomingTransferState();
    const senderKeyExchange = await createTransferKeyExchangeMessage(senderState, manifest.transferId);
    const channel = new FakeDataChannel("files");
    const { result } = renderHook(() => usePeerTransfer(input));

    await act(async () => {
      await serverListener?.({ type: "signal", payload: { type: "offer", sdp: "offer-sdp" } });
    });
    FakeRTCPeerConnection.instances[0]?.emitDataChannel(channel);
    await act(async () => {
      channel.dispatchMessage(JSON.stringify(senderKeyExchange));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(channel.sent.map((payload) => JSON.parse(payload)).some((message) => message.type === "key-exchange")).toBe(true);
    });
    const recipientKeyExchange = channel.sent.map((payload) => parseDataChannelTransferMessage(payload)).find((message) => message?.type === "key-exchange");
    if (!recipientKeyExchange || recipientKeyExchange.type !== "key-exchange") {
      throw new Error("expected recipient key exchange");
    }
    await acceptTransferMessage(senderState, recipientKeyExchange);
    const contentKey = getTransferContentKey(senderState, manifest.transferId);
    if (!contentKey) {
      throw new Error("expected sender content key");
    }
    const firstChunk = await createEncryptedChunkMessage(file, manifest, 0, contentKey);

    await waitFor(() => expect(result.current.verificationPhrase).toBeDefined());
    act(() => result.current.confirmVerificationPhrase());

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    await act(async () => {
      channel.dispatchMessage(JSON.stringify(createManifestMessage(manifest)));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.progress).toMatchObject({
      transferId: "transfer-1",
      totalBytes: 11,
      totalChunks: 2,
      completedChunks: 0,
      receivedBytes: 0,
    });

    nowSpy.mockReturnValue(1_700_000_001_000);
    await act(async () => {
      channel.dispatchMessage(JSON.stringify(firstChunk));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.progress).toMatchObject({
        totalBytes: 11,
        totalChunks: 2,
        completedChunks: 1,
        receivedBytes: 6,
        speedBytesPerSecond: 6,
      });
    });
  });

  it("acknowledges decrypted chunks through the room socket", async () => {
    let serverListener: ((message: ServerRoomMessage) => void) | undefined;
    const sendRoomMessage = vi.fn();
    const input = {
      files: [],
      manifests: [],
      onServerMessage: (listener: (message: ServerRoomMessage) => void) => {
        serverListener = listener;
        return () => {
          serverListener = undefined;
        };
      },
      pairingStatus: "connected",
      role: "recipient" as const,
      sendRoomMessage,
    };
    const file = new File(["hello"], "hello.txt", { type: "text/plain", lastModified: 1_700_000_000_000 });
    const manifest: FileManifest = {
      transferId: "transfer-1",
      fileId: "file-1",
      name: "hello.txt",
      size: file.size,
      type: "text/plain",
      lastModified: file.lastModified,
      chunkSize: 8,
      chunkCount: 1,
    };
    const senderState = createIncomingTransferState();
    const senderKeyExchange = await createTransferKeyExchangeMessage(senderState, manifest.transferId);
    const channel = new FakeDataChannel("files");

    const { result } = renderHook(() => usePeerTransfer(input));

    await act(async () => {
      await serverListener?.({ type: "signal", payload: { type: "offer", sdp: "offer-sdp" } });
    });
    FakeRTCPeerConnection.instances[0]?.emitDataChannel(channel);

    await act(async () => {
      channel.dispatchMessage(JSON.stringify(senderKeyExchange));
    });
    await waitFor(() => {
      expect(channel.sent.map((payload) => JSON.parse(payload)).some((message) => message.type === "key-exchange")).toBe(true);
    });
    const recipientKeyExchange = channel.sent.map((payload) => parseDataChannelTransferMessage(payload)).find((message) => message?.type === "key-exchange");
    if (!recipientKeyExchange || recipientKeyExchange.type !== "key-exchange") {
      throw new Error("expected recipient key exchange");
    }
    await acceptTransferMessage(senderState, recipientKeyExchange);
    const contentKey = getTransferContentKey(senderState, manifest.transferId);
    if (!contentKey) {
      throw new Error("expected sender content key");
    }
    const transferMessages = await createTransferMessages(file, manifest, contentKey);

    await waitFor(() => expect(result.current.verificationPhrase).toBeDefined());
    act(() => result.current.confirmVerificationPhrase());

    await act(async () => {
      for (const message of transferMessages) {
        channel.dispatchMessage(JSON.stringify(message));
      }
    });

    await waitFor(() => {
      expect(sendRoomMessage).toHaveBeenCalledWith({
        type: "ack",
        ack: expect.objectContaining({
          transferId: "transfer-1",
          fileId: "file-1",
          chunkIndex: 0,
          hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      });
    });
    await waitFor(async () => {
      await expect(loadReceivedFile(manifest).then((storedFile) => storedFile?.text())).resolves.toBe("hello");
    });
    expect(result.current.verificationPhrase?.replaceAll("-", "")).toMatch(/^[A-Z2-9]{26}$/);
  });

  it("streams received chunks to a selected directory handle", async () => {
    const writes: Array<{ position: number; text: string }> = [];
    const temporaryWritable = {
      close: vi.fn(async () => {}),
      write: vi.fn(async ({ position, data }: { position: number; data: ArrayBuffer }) => {
        writes.push({ position, text: new TextDecoder().decode(data) });
      }),
    };
    const destinationWritable = {
      close: vi.fn(async () => {}),
      write: vi.fn(async () => {}),
    };
    vi.stubGlobal(
      "showDirectoryPicker",
      vi.fn(async () => ({
        getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
          if (options?.create === false) {
            throw new DOMException("missing", "NotFoundError");
          }
          return name.endsWith(".part")
            ? { createWritable: async () => temporaryWritable, getFile: async () => new File(["stream"], name) }
            : { createWritable: async () => destinationWritable };
        }),
        removeEntry: vi.fn(async () => {}),
      })),
    );
    let serverListener: ((message: ServerRoomMessage) => void) | undefined;
    const sendRoomMessage = vi.fn();
    const input = {
      files: [],
      manifests: [],
      onServerMessage: (listener: (message: ServerRoomMessage) => void) => {
        serverListener = listener;
        return () => {
          serverListener = undefined;
        };
      },
      pairingStatus: "connected",
      role: "recipient" as const,
      sendRoomMessage,
    };
    const file = new File(["stream"], "stream.txt", { type: "text/plain", lastModified: 1_700_000_000_000 });
    const manifest: FileManifest = {
      transferId: "transfer-stream",
      fileId: "file-stream",
      name: "stream.txt",
      size: file.size,
      type: "text/plain",
      lastModified: file.lastModified,
      chunkSize: 64,
      chunkCount: 1,
    };
    const senderState = createIncomingTransferState();
    const senderKeyExchange = await createTransferKeyExchangeMessage(senderState, manifest.transferId);
    const channel = new FakeDataChannel("files");
    const { result } = renderHook(() => usePeerTransfer(input));

    await act(async () => {
      await result.current.chooseReceiveDirectory();
      await serverListener?.({ type: "signal", payload: { type: "offer", sdp: "offer-sdp" } });
    });
    FakeRTCPeerConnection.instances[0]?.emitDataChannel(channel);

    await act(async () => {
      channel.dispatchMessage(JSON.stringify(senderKeyExchange));
    });
    await waitFor(() => {
      expect(channel.sent.map((payload) => JSON.parse(payload)).some((message) => message.type === "key-exchange")).toBe(true);
    });
    const recipientKeyExchange = channel.sent.map((payload) => parseDataChannelTransferMessage(payload)).find((message) => message?.type === "key-exchange");
    if (!recipientKeyExchange || recipientKeyExchange.type !== "key-exchange") {
      throw new Error("expected recipient key exchange");
    }
    await acceptTransferMessage(senderState, recipientKeyExchange);
    const contentKey = getTransferContentKey(senderState, manifest.transferId);
    if (!contentKey) {
      throw new Error("expected sender content key");
    }
    const transferMessages = await createTransferMessages(file, manifest, contentKey);

    await waitFor(() => expect(result.current.verificationPhrase).toBeDefined());
    act(() => result.current.confirmVerificationPhrase());

    await act(async () => {
      for (const message of transferMessages) {
        channel.dispatchMessage(JSON.stringify(message));
      }
    });

    await waitFor(() => {
      expect(writes).toEqual([{ position: 0, text: "stream" }]);
      expect(temporaryWritable.close).toHaveBeenCalledOnce();
      expect(destinationWritable.close).toHaveBeenCalledOnce();
      expect(result.current.receivedFiles).toContainEqual(
        expect.objectContaining({ name: "stream.txt", savedToDisk: true, size: file.size }),
      );
    });
    await expect(loadReceivedFile(manifest)).resolves.toBeUndefined();
    expect(sendRoomMessage).toHaveBeenCalledWith({
      type: "ack",
      ack: expect.objectContaining({ transferId: "transfer-stream", fileId: "file-stream", chunkIndex: 0 }),
    });
  });

  it("hydrates persisted ACK progress before resending selected files", async () => {
    let serverListener: ((message: ServerRoomMessage) => void) | undefined;
    const file = {
      size: 12,
      slice: () => new Blob(["test chunk"]),
    } as File;
    const manifest: FileManifest = {
      transferId: "transfer-1",
      fileId: "file-1",
      name: "resume.bin",
      size: 12,
      type: "application/octet-stream",
      lastModified: 1_700_000_000_000,
      chunkSize: 4,
      chunkCount: 3,
    };
    await saveChunkAckProgress({
      ack: { transferId: "transfer-1", fileId: "file-1", chunkIndex: 1, hash: "1".repeat(64) },
      expiresAt: Date.now() + 60_000,
      manifest,
      recoveryToken: "recovery-1",
    });
    const input = {
      expiresAt: Date.now() + 60_000,
      files: [file],
      manifests: [manifest],
      onServerMessage: (listener: (message: ServerRoomMessage) => void) => {
        serverListener = listener;
        return () => {
          serverListener = undefined;
        };
      },
      pairingStatus: "connected",
      recoveryToken: "recovery-1",
      role: "sender" as const,
      sendRoomMessage: vi.fn(),
    };
    const { result } = renderHook(() => usePeerTransfer(input));

    await act(async () => {
      await serverListener?.({ type: "peer-joined", role: "recipient" });
    });
    await waitFor(() => expect(FakeRTCPeerConnection.instances[0]?.dataChannel).toBeDefined());
    const channel = FakeRTCPeerConnection.instances[0]?.dataChannel;
    const recipientState = createIncomingTransferState();
    await waitFor(() => {
      expect(channel?.sent.map((payload) => JSON.parse(payload)).some((message) => message.type === "key-exchange")).toBe(true);
    });
    const senderKeyExchange = channel?.sent.map((payload) => parseDataChannelTransferMessage(payload)).find((message) => message?.type === "key-exchange");
    if (!senderKeyExchange || senderKeyExchange.type !== "key-exchange") {
      throw new Error("expected sender key exchange");
    }
    const recipientKeyExchange = await createTransferKeyExchangeMessage(recipientState, manifest.transferId);
    await acceptTransferMessage(recipientState, senderKeyExchange);
    await act(async () => {
      channel?.dispatchMessage(JSON.stringify(recipientKeyExchange));
    });
    await waitFor(() => expect(result.current.verificationPhrase).toBeDefined());
    act(() => result.current.confirmVerificationPhrase());
    await act(async () => channel?.dispatchMessage(JSON.stringify({ type: "verification-confirmed", transferId: manifest.transferId })));
    await act(async () => result.current.sendSelectedFiles());

    const sentChunks = channel?.sent.map((payload) => JSON.parse(payload)).filter((message) => message.type === "chunk-frame");
    expect(sentChunks?.map((message) => message.chunkIndex).sort()).toEqual([0, 2]);
  });

  it("rehydrates recipient manifests and completed chunk progress after refresh", async () => {
    const manifest: FileManifest = {
      transferId: "transfer-1",
      fileId: "file-1",
      name: "resume.bin",
      size: 12,
      type: "application/octet-stream",
      lastModified: 1_700_000_000_000,
      chunkSize: 4,
      chunkCount: 3,
    };
    const expiresAt = Date.now() + 60_000;
    await saveReceivedManifest({ expiresAt, manifest, recoveryToken: "recovery-1" });
    await saveChunkAckProgress({
      ack: { transferId: "transfer-1", fileId: "file-1", chunkIndex: 0, hash: "0".repeat(64) },
      expiresAt,
      manifest,
      recoveryToken: "recovery-1",
    });
    await saveChunkAckProgress({
      ack: { transferId: "transfer-1", fileId: "file-1", chunkIndex: 2, hash: "2".repeat(64) },
      expiresAt,
      manifest,
      recoveryToken: "recovery-1",
    });
    const input = {
      expiresAt,
      files: [],
      manifests: [],
      onServerMessage: () => () => {},
      pairingStatus: "connected",
      recoveryToken: "recovery-1",
      role: "recipient" as const,
      roomId: "room-ABC123",
      sendRoomMessage: vi.fn(),
    };

    const { result } = renderHook(() => usePeerTransfer(input));

    await waitFor(() => {
      expect(result.current.progress).toMatchObject({
        transferId: "transfer-1",
        totalBytes: 12,
        totalChunks: 3,
        completedChunks: 2,
        receivedBytes: 8,
      });
    });
  });

  it("falls back to encrypted spillover when no peer data channel is open", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body as ArrayBuffer | undefined;
      const headers = new Headers(init?.headers);

      return Response.json({
        transferId: "transfer-1",
        fileId: "file-1",
        chunkIndex: Number(String(_url).split("/").at(-1)),
        ivBase64: headers.get("x-spillover-iv"),
        ciphertextBytes: body?.byteLength ?? 0,
        expiresAt: 1_700_000_000_000,
      });
    }));
    let serverListener: ((message: ServerRoomMessage) => void) | undefined;
    const file = new File(["relay fallback"], "relay.txt", { type: "text/plain", lastModified: 1_700_000_000_000 });
    const manifest: FileManifest = {
      transferId: "transfer-1",
      fileId: "file-1",
      name: "relay.txt",
      size: file.size,
      type: "text/plain",
      lastModified: file.lastModified,
      chunkSize: 64,
      chunkCount: 1,
    };
    const sendRoomMessage = vi.fn();
    const input = {
      files: [file],
      manifests: [manifest],
      onServerMessage: (listener: (message: ServerRoomMessage) => void) => {
        serverListener = listener;
        return () => {
          serverListener = undefined;
        };
      },
      pairingStatus: "connected",
      recoveryToken: "recovery-1",
      role: "sender" as const,
      roomId: "room-ABC123",
      sendRoomMessage,
    };
    const recipientState = createIncomingTransferState();
    const { result } = renderHook(() => usePeerTransfer(input));

    await waitFor(() => {
      expect(sendRoomMessage).toHaveBeenCalledWith({
        type: "transfer",
        message: expect.objectContaining({ type: "key-exchange", transferId: "transfer-1" }),
      });
    });
    const senderKeyExchange = sendRoomMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === "transfer" && message.message.type === "key-exchange")?.message;
    if (!senderKeyExchange || senderKeyExchange.type !== "key-exchange") {
      throw new Error("expected sender key exchange");
    }
    const recipientKeyExchange = await createTransferKeyExchangeMessage(recipientState, manifest.transferId);
    await acceptTransferMessage(recipientState, senderKeyExchange);

    await act(async () => {
      await serverListener?.({ type: "transfer", message: recipientKeyExchange });
    });
    await waitFor(() => expect(result.current.verificationPhrase).toBeDefined());
    act(() => result.current.confirmVerificationPhrase());
    await act(async () => {
      await serverListener?.({ type: "transfer", message: { type: "verification-confirmed", transferId: manifest.transferId } });
    });
    await act(async () => result.current.sendSelectedFiles());

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sendRoomMessage).toHaveBeenCalledWith({ type: "transfer", message: { type: "manifest", manifest } });
    expect(sendRoomMessage).toHaveBeenCalledWith({
      type: "spillover-chunk",
      chunk: expect.objectContaining({ transferId: "transfer-1", fileId: "file-1", chunkIndex: 0 }),
    });
  });

  it("renegotiates a sender peer after the data channel closes before completion", async () => {
    let serverListener: ((message: ServerRoomMessage) => void) | undefined;
    const input = {
      files: [],
      manifests: [],
      onServerMessage: (listener: (message: ServerRoomMessage) => void) => {
        serverListener = listener;
        return () => {
          serverListener = undefined;
        };
      },
      pairingStatus: "connected",
      recoveryToken: "recovery-1",
      role: "sender" as const,
      roomId: "room-ABC123",
      sendRoomMessage: vi.fn(),
    };

    renderHook(() => usePeerTransfer(input));

    await act(async () => {
      await serverListener?.({ type: "peer-joined", role: "recipient" });
    });
    expect(FakeRTCPeerConnection.instances).toHaveLength(1);

    act(() => {
      FakeRTCPeerConnection.instances[0]?.dataChannel?.close();
    });
    await act(async () => {
      await serverListener?.({ type: "peer-joined", role: "recipient" });
    });

    expect(FakeRTCPeerConnection.instances).toHaveLength(2);
  });

  it("uses Worker-issued TURN ICE servers when creating a peer connection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          expiresAt: Date.now() + 60_000,
          iceServers: [{ urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "p" }],
        }),
      ),
    );
    let serverListener: ((message: ServerRoomMessage) => void) | undefined;
    const input = {
      files: [],
      manifests: [],
      onServerMessage: (listener: (message: ServerRoomMessage) => void) => {
        serverListener = listener;
        return () => {
          serverListener = undefined;
        };
      },
      pairingStatus: "connected",
      recoveryToken: "recovery-1",
      role: "sender" as const,
      roomId: "room-ABC123",
      sendRoomMessage: vi.fn(),
    };

    renderHook(() => usePeerTransfer(input));

    await act(async () => {
      await serverListener?.({ type: "peer-joined", role: "recipient" });
    });

    await waitFor(() => {
      expect(FakeRTCPeerConnection.instances[0]?.configuration).toEqual({
        iceServers: [{ urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "p" }],
      });
    });
  });

  it("marks sender integrity verified when all sent chunks are acknowledged with matching hashes", async () => {
    let serverListener: ((message: ServerRoomMessage) => void) | undefined;
    const file = new File(["verified"], "verified.txt", {
      type: "text/plain",
      lastModified: 1_700_000_000_000,
    });
    const manifest: FileManifest = {
      transferId: "transfer-1",
      fileId: "file-1",
      name: "verified.txt",
      size: file.size,
      type: "text/plain",
      lastModified: file.lastModified,
      chunkSize: 64,
      chunkCount: 1,
    };
    const input = {
      files: [file],
      manifests: [manifest],
      onServerMessage: (listener: (message: ServerRoomMessage) => void) => {
        serverListener = listener;
        return () => {
          serverListener = undefined;
        };
      },
      pairingStatus: "connected",
      role: "sender" as const,
      sendRoomMessage: vi.fn(),
    };
    const recipientState = createIncomingTransferState();
    const { result } = renderHook(() => usePeerTransfer(input));

    await act(async () => {
      await serverListener?.({ type: "peer-joined", role: "recipient" });
    });
    await waitFor(() => expect(FakeRTCPeerConnection.instances[0]?.dataChannel).toBeDefined());
    const channel = FakeRTCPeerConnection.instances[0]?.dataChannel;
    await waitFor(() => {
      expect(channel?.sent.map((payload) => JSON.parse(payload)).some((message) => message.type === "key-exchange")).toBe(true);
    });
    const senderKeyExchange = channel?.sent.map((payload) => parseDataChannelTransferMessage(payload)).find((message) => message?.type === "key-exchange");
    if (!senderKeyExchange || senderKeyExchange.type !== "key-exchange") {
      throw new Error("expected sender key exchange");
    }
    const recipientKeyExchange = await createTransferKeyExchangeMessage(recipientState, manifest.transferId);
    await acceptTransferMessage(recipientState, senderKeyExchange);

    await act(async () => {
      channel?.dispatchMessage(JSON.stringify(recipientKeyExchange));
    });
    await waitFor(() => expect(result.current.verificationPhrase).toBeDefined());
    act(() => result.current.confirmVerificationPhrase());
    await act(async () => channel?.dispatchMessage(JSON.stringify({ type: "verification-confirmed", transferId: manifest.transferId })));
    await act(async () => result.current.sendSelectedFiles());
    const chunkFrame = channel?.sent.map((payload) => parseDataChannelTransferMessage(payload)).find((message) => message?.type === "chunk-frame");
    if (!chunkFrame || chunkFrame.type !== "chunk-frame") {
      throw new Error("expected encrypted chunk frame");
    }
    const ack = await createChunkAck({
      type: "chunk",
      transferId: chunkFrame.transferId,
      fileId: chunkFrame.fileId,
      chunkIndex: chunkFrame.chunkIndex,
      ivBase64: chunkFrame.ivBase64,
      ciphertextBase64: chunkFrame.ciphertextBase64,
    });

    await act(async () => {
      await serverListener?.({ type: "ack", ack });
    });

    await waitFor(() => {
      expect(result.current.integrityStatus).toBe("verified");
    });
  });

  it("marks sender integrity mismatch when an ACK hash differs from the sent chunk hash", async () => {
    let serverListener: ((message: ServerRoomMessage) => void) | undefined;
    const file = new File(["tamper"], "tamper.txt", {
      type: "text/plain",
      lastModified: 1_700_000_000_000,
    });
    const manifest: FileManifest = {
      transferId: "transfer-1",
      fileId: "file-1",
      name: "tamper.txt",
      size: file.size,
      type: "text/plain",
      lastModified: file.lastModified,
      chunkSize: 64,
      chunkCount: 1,
    };
    const input = {
      files: [file],
      manifests: [manifest],
      onServerMessage: (listener: (message: ServerRoomMessage) => void) => {
        serverListener = listener;
        return () => {
          serverListener = undefined;
        };
      },
      pairingStatus: "connected",
      role: "sender" as const,
      sendRoomMessage: vi.fn(),
    };
    const recipientState = createIncomingTransferState();
    const { result } = renderHook(() => usePeerTransfer(input));

    await act(async () => {
      await serverListener?.({ type: "peer-joined", role: "recipient" });
    });
    await waitFor(() => expect(FakeRTCPeerConnection.instances[0]?.dataChannel).toBeDefined());
    const channel = FakeRTCPeerConnection.instances[0]?.dataChannel;
    await waitFor(() => {
      expect(channel?.sent.map((payload) => JSON.parse(payload)).some((message) => message.type === "key-exchange")).toBe(true);
    });
    const senderKeyExchange = channel?.sent.map((payload) => parseDataChannelTransferMessage(payload)).find((message) => message?.type === "key-exchange");
    if (!senderKeyExchange || senderKeyExchange.type !== "key-exchange") {
      throw new Error("expected sender key exchange");
    }
    const recipientKeyExchange = await createTransferKeyExchangeMessage(recipientState, manifest.transferId);
    await acceptTransferMessage(recipientState, senderKeyExchange);

    await act(async () => {
      channel?.dispatchMessage(JSON.stringify(recipientKeyExchange));
    });
    await waitFor(() => expect(result.current.verificationPhrase).toBeDefined());
    act(() => result.current.confirmVerificationPhrase());
    await act(async () => channel?.dispatchMessage(JSON.stringify({ type: "verification-confirmed", transferId: manifest.transferId })));
    await act(async () => result.current.sendSelectedFiles());
    await waitFor(() => {
      expect(result.current.integrityStatus).toBe("pending");
    });

    await act(async () => {
      await serverListener?.({
        type: "ack",
        ack: { transferId: "transfer-1", fileId: "file-1", chunkIndex: 0, hash: "f".repeat(64) },
      });
    });

    await waitFor(() => {
      expect(result.current.status).toBe("error");
      expect(result.current.integrityStatus).toBe("mismatch");
    });
  });
});

class FakeDataChannel extends EventTarget {
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState: RTCDataChannelState = "open";
  readonly sent: string[] = [];

  constructor(readonly label: string) {
    super();
  }

  close(): void {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }

  dispatchMessage(payload: string): void {
    this.dispatchEvent(new MessageEvent("message", { data: payload }));
  }

  send(payload: string): void {
    this.sent.push(payload);
  }
}

class FakeRTCPeerConnection extends EventTarget {
  static readonly instances: FakeRTCPeerConnection[] = [];
  readonly configuration?: RTCConfiguration;
  dataChannel?: FakeDataChannel;
  localDescription: RTCSessionDescriptionInit | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;

  constructor(configuration?: RTCConfiguration) {
    super();
    this.configuration = configuration;
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

  emitDataChannel(channel: FakeDataChannel): void {
    this.ondatachannel?.({ channel } as unknown as RTCDataChannelEvent);
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

function deleteProgressDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("secure-p2p-transfer");

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("progress database deletion blocked"));
  });
}
