import { afterEach, describe, expect, it } from "vitest";
import type { ChunkAck, FileManifest } from "../../shared/protocol";
import { loadChunkAckHashes, loadCompletedChunkIndexes, saveChunkAckProgress } from "./ackProgress";

describe("ackProgress", () => {
  afterEach(async () => {
    await deleteProgressDb();
  });

  it("stores acknowledged chunks in the persisted recovery bitmap", async () => {
    const manifest = createManifest(3);

    await saveChunkAckProgress({
      ack: createAck(1),
      expiresAt: Date.now() + 60_000,
      manifest,
      recoveryToken: "recovery-1",
    });

    await expect(loadCompletedChunkIndexes(manifest, "recovery-1")).resolves.toEqual(new Set([1]));
    await expect(loadChunkAckHashes(manifest, "recovery-1")).resolves.toEqual(new Map([[1, "1".repeat(64)]]));
  });

  it("preserves earlier acknowledged chunks for the same file", async () => {
    const manifest = createManifest(3);

    await saveChunkAckProgress({
      ack: createAck(0),
      expiresAt: Date.now() + 60_000,
      manifest,
      recoveryToken: "recovery-1",
    });
    await saveChunkAckProgress({
      ack: createAck(2),
      expiresAt: Date.now() + 60_000,
      manifest,
      recoveryToken: "recovery-1",
    });

    await expect(loadCompletedChunkIndexes(manifest, "recovery-1")).resolves.toEqual(new Set([0, 2]));
    await expect(loadChunkAckHashes(manifest, "recovery-1")).resolves.toEqual(
      new Map([
        [0, "0".repeat(64)],
        [2, "2".repeat(64)],
      ]),
    );
  });

  it("ignores persisted progress for a different recovery token", async () => {
    const manifest = createManifest(2);

    await saveChunkAckProgress({
      ack: createAck(0),
      expiresAt: Date.now() + 60_000,
      manifest,
      recoveryToken: "recovery-1",
    });

    await expect(loadCompletedChunkIndexes(manifest, "recovery-2")).resolves.toEqual(new Set());
    await expect(loadChunkAckHashes(manifest, "recovery-2")).resolves.toEqual(new Map());
  });
});

function createManifest(chunkCount: number): FileManifest {
  return {
    transferId: "transfer-1",
    fileId: "file-1",
    name: "file.bin",
    size: chunkCount,
    type: "application/octet-stream",
    lastModified: 1_700_000_000_000,
    chunkSize: 1,
    chunkCount,
  };
}

function createAck(chunkIndex: number): ChunkAck {
  return {
    transferId: "transfer-1",
    fileId: "file-1",
    chunkIndex,
    hash: String(chunkIndex).repeat(64),
  };
}

function deleteProgressDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("secure-p2p-transfer");

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("progress database deletion blocked"));
  });
}
