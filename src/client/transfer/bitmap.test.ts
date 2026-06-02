import { describe, expect, it } from "vitest";
import { createChunkBitmap, markChunkComplete, missingChunkIndexes } from "./bitmap";

describe("chunk bitmap", () => {
  it("tracks completed and missing chunks", () => {
    let bitmap = createChunkBitmap(5);
    bitmap = markChunkComplete(bitmap, 1);
    bitmap = markChunkComplete(bitmap, 3);

    expect(missingChunkIndexes(bitmap)).toEqual([0, 2, 4]);
  });

  it("rejects invalid total chunks", () => {
    expect(() => createChunkBitmap(0)).toThrow("totalChunks must be a positive integer");
    expect(() => createChunkBitmap(1.5)).toThrow("totalChunks must be a positive integer");
  });

  it("rejects chunk indexes outside the bitmap", () => {
    const bitmap = createChunkBitmap(2);

    expect(() => markChunkComplete(bitmap, -1)).toThrow("chunk index out of range");
    expect(() => markChunkComplete(bitmap, 2)).toThrow("chunk index out of range");
    expect(() => markChunkComplete(bitmap, 0.5)).toThrow("chunk index out of range");
  });

  it("does not mutate the original bitmap when marking a chunk complete", () => {
    const original = createChunkBitmap(3);
    const updated = markChunkComplete(original, 1);

    expect(original.completed).toEqual([false, false, false]);
    expect(updated.completed).toEqual([false, true, false]);
    expect(updated).not.toBe(original);
  });
});
