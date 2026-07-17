import { afterEach, describe, expect, it } from "vitest";
import type { FileManifest } from "../../shared/protocol";
import { loadReceivedFile, saveReceivedChunk } from "./receivedChunkStore";
import { loadProgress, saveProgress } from "./progressStore";

describe("receivedChunkStore", () => {
  afterEach(async () => {
    await deleteTransferDb();
  });

  it("reconstructs a received file after all chunks are stored", async () => {
    const manifest = createManifest(3);

    await saveReceivedChunk({ manifest, chunkIndex: 1, bytes: bytes("two") });
    await saveReceivedChunk({ manifest, chunkIndex: 0, bytes: bytes("one") });

    await expect(loadReceivedFile(manifest)).resolves.toBeUndefined();

    await saveReceivedChunk({ manifest, chunkIndex: 2, bytes: bytes("tri") });
    const file = await loadReceivedFile(manifest);

    expect(file?.name).toBe("joined.txt");
    expect(file?.type).toBe("text/plain");
    expect(await file?.text()).toBe("onetwotri");
  });

  it("does not break progress storage after the chunk store upgrades the database", async () => {
    const manifest = createManifest(1);

    await saveReceivedChunk({ manifest, chunkIndex: 0, bytes: bytes("one") });
    await saveProgress({
      transferId: manifest.transferId,
      fileId: manifest.fileId,
      completed: [true],
      recoveryToken: "recovery-1",
      expiresAt: Date.now() + 60_000,
    });

    await expect(loadProgress(manifest.transferId, manifest.fileId)).resolves.toMatchObject({
      completed: [true],
      recoveryToken: "recovery-1",
    });
  });
});

function createManifest(chunkCount: number): FileManifest {
  return {
    transferId: "transfer-1",
    fileId: "file-1",
    name: "joined.txt",
    size: chunkCount * 3,
    type: "text/plain",
    lastModified: 1_700_000_000_000,
    chunkSize: 3,
    chunkCount,
  };
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>;
}

function deleteTransferDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("secure-p2p-transfer");

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("database deletion blocked"));
  });
}
