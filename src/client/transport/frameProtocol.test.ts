import { describe, expect, it } from "vitest";
import { splitIntoFrames } from "./frameProtocol";

describe("splitIntoFrames", () => {
  it("splits a logical chunk into bounded subframes", () => {
    const chunk = new Uint8Array(10);
    const frames = splitIntoFrames({ transferId: "t1", fileId: "f1", chunkIndex: 3, bytes: chunk, frameSize: 4 });

    expect(frames.map((frame) => frame.bytes.byteLength)).toEqual([4, 4, 2]);
    expect(frames.map((frame) => frame.frameIndex)).toEqual([0, 1, 2]);
    expect(frames.map((frame) => frame.finalFrame)).toEqual([false, false, true]);
    expect(frames.map(({ transferId, fileId, chunkIndex }) => ({ transferId, fileId, chunkIndex }))).toEqual([
      { transferId: "t1", fileId: "f1", chunkIndex: 3 },
      { transferId: "t1", fileId: "f1", chunkIndex: 3 },
      { transferId: "t1", fileId: "f1", chunkIndex: 3 },
    ]);
  });

  it("rejects invalid frame sizes", () => {
    const chunk = new Uint8Array(1);

    expect(() => splitIntoFrames({ transferId: "t1", fileId: "f1", chunkIndex: 0, bytes: chunk, frameSize: 0 })).toThrow(
      "frameSize must be a positive integer",
    );
    expect(() => splitIntoFrames({ transferId: "t1", fileId: "f1", chunkIndex: 0, bytes: chunk, frameSize: 1.5 })).toThrow(
      "frameSize must be a positive integer",
    );
  });

  it("marks the second frame final for an exact multiple", () => {
    const frames = splitIntoFrames({ transferId: "t1", fileId: "f1", chunkIndex: 0, bytes: new Uint8Array(8), frameSize: 4 });

    expect(frames.map((frame) => frame.bytes.byteLength)).toEqual([4, 4]);
    expect(frames.map((frame) => frame.finalFrame)).toEqual([false, true]);
  });

  it("returns no frames for zero-byte input", () => {
    expect(splitIntoFrames({ transferId: "t1", fileId: "f1", chunkIndex: 0, bytes: new Uint8Array(0), frameSize: 4 })).toEqual([]);
  });
});
