import { describe, expect, it } from "vitest";
import { loadProgress, saveProgress } from "./progressStore";

describe("progressStore", () => {
  it("saves and loads transfer recovery progress", async () => {
    await saveProgress({
      transferId: "transfer-1",
      fileId: "file-1",
      completed: [true, false, true],
      recoveryToken: "token-1",
      expiresAt: Date.now() + 1000,
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
});
