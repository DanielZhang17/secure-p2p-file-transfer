import { describe, expect, it } from "vitest";
import { GiB } from "../../shared/limits";
import type { FileManifest } from "../../shared/protocol";
import { sendPeerTransferFiles } from "./peerSender";

describe("sendPeerTransferFiles", () => {
  it("retries failed chunk sends and reports progress", async () => {
    const manifest: FileManifest = {
      transferId: "transfer-1",
      fileId: "file-1",
      name: "large.bin",
      size: GiB + 1,
      type: "application/octet-stream",
      lastModified: 1_700_000_000_000,
      chunkSize: 4,
      chunkCount: 2,
    };
    const file = {
      size: GiB + 1,
      slice: () => new Blob(["test chunk"]),
    } as File;
    const channel = new FakeSendChannel();
    const progress: Array<{ activeLanes: number; completedChunks: number; retryCount: number }> = [];

    const result = await sendPeerTransferFiles({
      channel: channel as unknown as RTCDataChannel,
      contentKeyForTransfer: () => generateTestContentKey(),
      files: [file],
      manifests: [manifest],
      maxRetries: 1,
      onProgress: (nextProgress) => progress.push(nextProgress),
    });

    const sentMessages = channel.sent.map((payload) => JSON.parse(payload));
    expect(sentMessages.map((message) => message.type)).toEqual(["manifest", "chunk-frame", "chunk-frame"]);
    expect(sentMessages.filter((message) => message.type === "chunk-frame").map((message) => message.chunkIndex)).toEqual([
      0,
      1,
    ]);
    expect(JSON.stringify(sentMessages)).not.toContain("test chunk");
    expect(result).toMatchObject({ completedChunks: 2, retryCount: 1 });
    expect(progress).toContainEqual(expect.objectContaining({ activeLanes: 8, retryCount: 1 }));
    expect(progress).toContainEqual(expect.objectContaining({ activeLanes: 4, retryCount: 1 }));
    expect(progress.at(-1)).toMatchObject({ activeLanes: 0, completedChunks: 2, retryCount: 1 });
  });

  it("skips chunks already acknowledged by a previous send attempt", async () => {
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
    const file = {
      size: 12,
      slice: () => new Blob(["test chunk"]),
    } as File;
    const channel = new FakeSendChannel();
    const progress: Array<{ activeLanes: number; completedChunks: number; retryCount: number }> = [];

    const result = await sendPeerTransferFiles({
      channel: channel as unknown as RTCDataChannel,
      contentKeyForTransfer: () => generateTestContentKey(),
      files: [file],
      isChunkComplete: (_manifest, chunkIndex) => chunkIndex === 1,
      manifests: [manifest],
      onProgress: (nextProgress) => progress.push(nextProgress),
    });

    const sentChunks = channel.sent.map((payload) => JSON.parse(payload)).filter((message) => message.type === "chunk-frame");
    expect(sentChunks.map((message) => message.chunkIndex).sort()).toEqual([0, 2]);
    expect(result).toMatchObject({ completedChunks: 3, retryCount: 0 });
    expect(progress[0]).toMatchObject({ activeLanes: 2, completedChunks: 1 });
    expect(progress.at(-1)).toMatchObject({ activeLanes: 0, completedChunks: 3 });
  });
});

class FakeSendChannel extends EventTarget {
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly sent: string[] = [];
  readyState: RTCDataChannelState = "open";
  private failedChunkOne = false;

  send(payload: string): void {
    const message = JSON.parse(payload);
    if (message.type === "chunk-frame" && message.chunkIndex === 1 && !this.failedChunkOne) {
      this.failedChunkOne = true;
      throw new Error("temporary channel failure");
    }

    this.sent.push(payload);
  }
}

function generateTestContentKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
