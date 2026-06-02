import { useCallback, useMemo, useState } from "react";
import type { FileManifest, TransferProgress } from "../../shared/protocol";
import { createFileManifest } from "./manifest";

const ONE_GIB = 1024 * 1024 * 1024;

export function useTransferSession() {
  const [files, setFiles] = useState<File[]>([]);
  const [manifests, setManifests] = useState<FileManifest[]>([]);

  const progress = useMemo<TransferProgress>(() => {
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const totalChunks = manifests.reduce((sum, manifest) => sum + manifest.chunkCount, 0);

    return {
      transferId: manifests[0]?.transferId ?? "pending",
      mode: "direct-p2p",
      totalBytes,
      sentBytes: 0,
      receivedBytes: 0,
      completedChunks: 0,
      totalChunks,
      retryCount: 0,
      activeLanes: totalBytes === 0 ? 0 : totalBytes > ONE_GIB ? 8 : 2,
      spilloverBytes: 0,
    };
  }, [files, manifests]);

  const selectFiles = useCallback(async (nextFiles: File[]) => {
    const transferId = `transfer-${crypto.randomUUID()}`;

    setFiles(nextFiles);
    setManifests(
      await Promise.all(nextFiles.map((file, index) => createFileManifest(file, transferId, index))),
    );
  }, []);

  return {
    files,
    manifests,
    progress,
    selectFiles,
  };
}
