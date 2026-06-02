import { afterEach, describe, expect, it } from "vitest";
import { loadProgress, saveProgress } from "./progressStore";

describe("progressStore", () => {
  afterEach(async () => {
    await deleteProgressDb();
  });

  it("saves and loads transfer recovery progress", async () => {
    await saveProgress({
      transferId: "transfer-1",
      fileId: "file-1",
      completed: [true, false, true],
      recoveryToken: "token-1",
      expiresAt: Date.now() + 60_000,
    });

    await expect(loadProgress("transfer-1", "file-1")).resolves.toEqual({
      transferId: "transfer-1",
      fileId: "file-1",
      completed: [true, false, true],
      recoveryToken: "token-1",
      expiresAt: expect.any(Number),
    });
  });

  it("returns undefined for expired progress", async () => {
    await saveProgress({
      transferId: "transfer-expired",
      fileId: "file-expired",
      completed: [true],
      recoveryToken: "token-expired",
      expiresAt: Date.now() - 1,
    });

    await expect(loadProgress("transfer-expired", "file-expired")).resolves.toBeUndefined();
  });

  it("returns undefined for missing progress", async () => {
    await expect(loadProgress("transfer-missing", "file-missing")).resolves.toBeUndefined();
  });

  it("does not collide when transfer and file ids contain colons", async () => {
    await saveProgress({
      transferId: "a:b",
      fileId: "c",
      completed: [true, false],
      recoveryToken: "token-left",
      expiresAt: Date.now() + 60_000,
    });
    await saveProgress({
      transferId: "a",
      fileId: "b:c",
      completed: [false, true],
      recoveryToken: "token-right",
      expiresAt: Date.now() + 60_000,
    });

    await expect(loadProgress("a:b", "c")).resolves.toMatchObject({
      transferId: "a:b",
      fileId: "c",
      completed: [true, false],
      recoveryToken: "token-left",
    });
    await expect(loadProgress("a", "b:c")).resolves.toMatchObject({
      transferId: "a",
      fileId: "b:c",
      completed: [false, true],
      recoveryToken: "token-right",
    });
  });
});

function deleteProgressDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("secure-p2p-transfer");

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("progress database deletion blocked"));
  });
}
