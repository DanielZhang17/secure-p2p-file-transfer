import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTransferSession } from "./useTransferSession";

describe("useTransferSession", () => {
  it("starts with idle progress", () => {
    const { result } = renderHook(() => useTransferSession());

    expect(result.current.files).toEqual([]);
    expect(result.current.manifests).toEqual([]);
    expect(result.current.progress).toMatchObject({
      transferId: "pending",
      mode: "direct-p2p",
      totalBytes: 0,
      totalChunks: 0,
      activeLanes: 0,
    });
  });

  it("creates manifests when sender selects files", async () => {
    const { result } = renderHook(() => useTransferSession());
    const file = new File(["hello"], "hello.txt", {
      type: "text/plain",
      lastModified: 1700000000000,
    });

    await act(async () => {
      await result.current.selectFiles([file]);
    });

    expect(result.current.files).toEqual([file]);
    expect(result.current.manifests).toHaveLength(1);
    expect(result.current.manifests[0]).toMatchObject({
      name: "hello.txt",
      size: 5,
      chunkCount: 1,
    });
    expect(result.current.progress).toMatchObject({
      transferId: result.current.manifests[0].transferId,
      totalBytes: 5,
      totalChunks: 1,
      activeLanes: 2,
    });
  });

  it("uses selection index to distinguish multiple files with the same metadata", async () => {
    const { result } = renderHook(() => useTransferSession());
    const options = {
      type: "application/octet-stream",
      lastModified: 1700000000000,
    };
    const files = [
      new File(["same"], "duplicate.bin", options),
      new File(["same"], "duplicate.bin", options),
    ];

    await act(async () => {
      await result.current.selectFiles(files);
    });

    expect(result.current.manifests).toHaveLength(2);
    expect(result.current.manifests[0].transferId).toBe(result.current.manifests[1].transferId);
    expect(result.current.manifests[0].fileId).not.toBe(result.current.manifests[1].fileId);
  });
});
