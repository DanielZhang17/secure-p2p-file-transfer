import { describe, expect, it } from "vitest";
import { scheduleChunks } from "./scheduler";

describe("scheduleChunks", () => {
  it("rejects invalid lanes", async () => {
    await expect(
      scheduleChunks({
        chunkIndexes: [0],
        lanes: 0,
        maxRetries: 1,
        sendChunk: async () => {},
      }),
    ).rejects.toThrow("lanes must be a positive integer");

    await expect(
      scheduleChunks({
        chunkIndexes: [0],
        lanes: Number.NaN,
        maxRetries: 1,
        sendChunk: async () => {},
      }),
    ).rejects.toThrow("lanes must be a positive integer");
  });

  it("rejects invalid maxRetries", async () => {
    await expect(
      scheduleChunks({
        chunkIndexes: [0],
        lanes: 1,
        maxRetries: -1,
        sendChunk: async () => {},
      }),
    ).rejects.toThrow("maxRetries must be a non-negative integer");

    await expect(
      scheduleChunks({
        chunkIndexes: [0],
        lanes: 1,
        maxRetries: Number.NaN,
        sendChunk: async () => {},
      }),
    ).rejects.toThrow("maxRetries must be a non-negative integer");
  });

  it("rejects invalid chunk index", async () => {
    await expect(
      scheduleChunks({
        chunkIndexes: [0, -1],
        lanes: 1,
        maxRetries: 1,
        sendChunk: async () => {},
      }),
    ).rejects.toThrow("chunk indexes must be non-negative integers");
  });

  it("runs no more than the configured lane count", async () => {
    let active = 0;
    let maxActive = 0;

    await scheduleChunks({
      chunkIndexes: [0, 1, 2, 3, 4],
      lanes: 2,
      maxRetries: 1,
      sendChunk: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
      },
    });

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("completes all chunks", async () => {
    const completed: number[] = [];

    await scheduleChunks({
      chunkIndexes: [0, 1, 2, 3, 4],
      lanes: 3,
      maxRetries: 1,
      sendChunk: async (chunkIndex) => {
        completed.push(chunkIndex);
      },
    });

    expect(completed.slice().sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it("retries a failed chunk and completes when it recovers", async () => {
    const attempts = new Map<number, number>();

    await scheduleChunks({
      chunkIndexes: [0],
      lanes: 1,
      maxRetries: 2,
      sendChunk: async (chunkIndex) => {
        attempts.set(chunkIndex, (attempts.get(chunkIndex) ?? 0) + 1);

        if (attempts.get(chunkIndex) === 1) {
          throw new Error("temporary failure");
        }
      },
    });

    expect(attempts.get(0)).toBe(2);
  });

  it("rejects after retries are exhausted", async () => {
    let attempts = 0;

    await expect(
      scheduleChunks({
        chunkIndexes: [0],
        lanes: 1,
        maxRetries: 1,
        sendChunk: async () => {
          attempts += 1;
          throw new Error("permanent failure");
        },
      }),
    ).rejects.toThrow("permanent failure");

    expect(attempts).toBe(2);
  });

  it("waits for active lanes and does not start queued chunks after retries are exhausted", async () => {
    const started: number[] = [];
    let secondLaneSettled = false;

    await expect(
      scheduleChunks({
        chunkIndexes: [0, 1, 2, 3, 4],
        lanes: 2,
        maxRetries: 0,
        sendChunk: async (chunkIndex) => {
          started.push(chunkIndex);

          if (chunkIndex === 0) {
            throw new Error("permanent failure");
          }

          await Promise.resolve();
          secondLaneSettled = true;
        },
      }),
    ).rejects.toThrow("permanent failure");

    expect(secondLaneSettled).toBe(true);
    expect(started).toEqual([0, 1]);
  });
});
