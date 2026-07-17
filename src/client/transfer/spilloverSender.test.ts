import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GiB } from "../../shared/limits";
import type { FileManifest } from "../../shared/protocol";
import { sendSpilloverTransferFiles } from "./spilloverSender";

describe("sendSpilloverTransferFiles", () => {
  beforeEach(() => {
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads encrypted chunks and sends manifest plus spillover references through the room", async () => {
    const file = new File(["hello relay"], "relay.txt", { type: "text/plain", lastModified: 1_700_000_000_000 });
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
    const progress: Array<{ activeLanes: number; completedChunks: number; spilloverBytes: number }> = [];

    const result = await sendSpilloverTransferFiles({
      credentials: { roomId: "room-ABC123", recoveryToken: "recovery-1" },
      contentKeyForTransfer: () => generateTestContentKey(),
      files: [file],
      manifests: [manifest],
      onProgress: (nextProgress) => progress.push(nextProgress),
      sendRoomMessage,
    });

    expect(sendRoomMessage).toHaveBeenCalledWith({ type: "transfer", message: { type: "manifest", manifest } });
    expect(sendRoomMessage).toHaveBeenCalledWith({
      type: "spillover-chunk",
      chunk: expect.objectContaining({ transferId: "transfer-1", fileId: "file-1", chunkIndex: 0 }),
    });
    expect(JSON.stringify(sendRoomMessage.mock.calls)).not.toContain("hello relay");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.completedChunks).toBe(1);
    expect(result.spilloverBytes).toBeGreaterThan(file.size);
    expect(progress.at(-1)).toMatchObject({ activeLanes: 0, completedChunks: 1 });
  });

  it("skips chunks already acknowledged by a previous spillover attempt", async () => {
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
    const sendRoomMessage = vi.fn();

    const result = await sendSpilloverTransferFiles({
      credentials: { roomId: "room-ABC123", recoveryToken: "recovery-1" },
      contentKeyForTransfer: () => generateTestContentKey(),
      files: [file],
      isChunkComplete: (_manifest, chunkIndex) => chunkIndex === 1,
      manifests: [manifest],
      sendRoomMessage,
    });

    const chunkMessages = sendRoomMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "spillover-chunk");
    expect(chunkMessages.map((message) => message.chunk.chunkIndex).sort()).toEqual([0, 2]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ completedChunks: 3, retryCount: 0 });
  });

  it("backs off active spillover lanes after a retry", async () => {
    let failedOnce = false;
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const chunkIndex = Number(String(_url).split("/").at(-1));
      if (chunkIndex === 1 && !failedOnce) {
        failedOnce = true;
        return new Response("temporary failure", { status: 503 });
      }

      const body = init?.body as ArrayBuffer | undefined;
      const headers = new Headers(init?.headers);

      return Response.json({
        transferId: "transfer-1",
        fileId: "file-1",
        chunkIndex,
        ivBase64: headers.get("x-spillover-iv"),
        ciphertextBytes: body?.byteLength ?? 0,
        expiresAt: 1_700_000_000_000,
      });
    }));

    const file = {
      size: GiB + 1,
      slice: () => new Blob(["test chunk"]),
    } as File;
    const manifest: FileManifest = {
      transferId: "transfer-1",
      fileId: "file-1",
      name: "large-relay.bin",
      size: GiB + 1,
      type: "application/octet-stream",
      lastModified: 1_700_000_000_000,
      chunkSize: 4,
      chunkCount: 2,
    };
    const progress: Array<{ activeLanes: number; completedChunks: number; retryCount: number }> = [];

    const result = await sendSpilloverTransferFiles({
      credentials: { roomId: "room-ABC123", recoveryToken: "recovery-1" },
      contentKeyForTransfer: () => generateTestContentKey(),
      files: [file],
      manifests: [manifest],
      maxRetries: 1,
      onProgress: (nextProgress) => progress.push(nextProgress),
      sendRoomMessage: vi.fn(),
    });

    expect(result).toMatchObject({ completedChunks: 2, retryCount: 1 });
    expect(progress).toContainEqual(expect.objectContaining({ activeLanes: 8, retryCount: 1 }));
    expect(progress).toContainEqual(expect.objectContaining({ activeLanes: 4, retryCount: 1 }));
    expect(progress.at(-1)).toMatchObject({ activeLanes: 0, completedChunks: 2, retryCount: 1 });
  });
});

function generateTestContentKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
