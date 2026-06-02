import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileManifest } from "../../shared/protocol";
import * as manifestModule from "./manifest";
import { useTransferSession } from "./useTransferSession";

describe("useTransferSession", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("uses selected-file lanes for zero-byte files", async () => {
    const { result } = renderHook(() => useTransferSession());
    const file = new File([], "empty.txt", {
      type: "text/plain",
      lastModified: 1700000000000,
    });

    await act(async () => {
      await result.current.selectFiles([file]);
    });

    expect(result.current.manifests).toHaveLength(1);
    expect(result.current.manifests[0].chunkCount).toBe(1);
    expect(result.current.progress).toMatchObject({
      totalBytes: 0,
      totalChunks: 1,
      activeLanes: 2,
    });
  });

  it("keeps manifests paired with the latest overlapping selection", async () => {
    const pendingManifests: Array<{
      file: File;
      transferId: string;
      selectionIndex: number;
      resolve: (manifest: FileManifest) => void;
    }> = [];
    vi.spyOn(manifestModule, "createFileManifest").mockImplementation(
      (file, transferId, selectionIndex = 0) =>
        new Promise((resolve) => {
          pendingManifests.push({ file, transferId, selectionIndex, resolve });
        }),
    );
    const { result } = renderHook(() => useTransferSession());
    const firstFile = new File(["first"], "first.txt", {
      type: "text/plain",
      lastModified: 1700000000000,
    });
    const secondFile = new File(["second"], "second.txt", {
      type: "text/plain",
      lastModified: 1700000000001,
    });
    const selections: Promise<void>[] = [];

    await act(async () => {
      selections.push(result.current.selectFiles([firstFile]));
      selections.push(result.current.selectFiles([secondFile]));
    });

    expect(pendingManifests).toHaveLength(2);

    await act(async () => {
      pendingManifests[1].resolve(createTestManifest(pendingManifests[1]));
      await selections[1];
    });

    expect(result.current.files).toEqual([secondFile]);
    expect(result.current.manifests[0]).toMatchObject({
      name: "second.txt",
      size: 6,
    });

    await act(async () => {
      pendingManifests[0].resolve(createTestManifest(pendingManifests[0]));
      await selections[0];
    });

    expect(result.current.files).toEqual([secondFile]);
    expect(result.current.manifests[0]).toMatchObject({
      name: "second.txt",
      size: 6,
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

function createTestManifest({
  file,
  transferId,
  selectionIndex,
}: {
  file: File;
  transferId: string;
  selectionIndex: number;
}): FileManifest {
  return {
    transferId,
    fileId: `file-${file.name}-${selectionIndex}`,
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified,
    chunkSize: 8,
    chunkCount: 1,
  };
}
