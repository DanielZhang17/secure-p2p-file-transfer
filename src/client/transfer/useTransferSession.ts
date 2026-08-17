import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SMALL_FILE_THRESHOLD_BYTES } from "../../shared/limits";
import type { FileManifest, TransferProgress } from "../../shared/protocol";
import { createFileManifest } from "./manifest";
import type { OutgoingManifestRecoveryScope } from "./outgoingManifestStore";
import { findReusableOutgoingManifests, loadOutgoingManifests, saveOutgoingManifests } from "./outgoingManifestStore";

interface TransferSessionState {
  files: File[];
  manifests: FileManifest[];
}

export function useTransferSession(recoveryScope: OutgoingManifestRecoveryScope = {}) {
  const storageScope = useMemo(
    () => ({ recoveryToken: recoveryScope.recoveryToken, roomId: recoveryScope.roomId }),
    [recoveryScope.recoveryToken, recoveryScope.roomId],
  );
  const [session, setSession] = useState<TransferSessionState>(() => ({
    files: [],
    manifests: loadOutgoingManifests(storageScope),
  }));
  const selectionSequence = useRef(0);
  const { files, manifests } = session;

  const progress = useMemo<TransferProgress>(() => {
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const totalChunks = manifests.reduce((sum, manifest) => sum + manifest.chunkCount, 0);

    return {
      transferId: manifests[0]?.transferId ?? "pending",
      mode: "negotiating",
      addressFamily: "unknown",
      totalBytes,
      sentBytes: 0,
      receivedBytes: 0,
      completedChunks: 0,
      totalChunks,
      retryCount: 0,
      activeLanes: files.length === 0 ? 0 : totalBytes > SMALL_FILE_THRESHOLD_BYTES ? 8 : 2,
      spilloverBytes: 0,
      speedBytesPerSecond: 0,
    };
  }, [files, manifests]);

  useEffect(() => {
    if (files.length > 0 && manifests.length > 0 && storageScope.recoveryToken && storageScope.roomId) {
      saveOutgoingManifests(manifests, storageScope);
    }
  }, [files.length, manifests, storageScope]);

  const selectFiles = useCallback(async (nextFiles: File[]) => {
    const sequence = selectionSequence.current + 1;
    selectionSequence.current = sequence;
    const reusableManifests = findReusableOutgoingManifests(nextFiles, storageScope);
    if (reusableManifests) {
      setSession({ files: nextFiles, manifests: reusableManifests });
      saveOutgoingManifests(reusableManifests, storageScope);
      return;
    }

    const transferId = `transfer-${crypto.randomUUID()}`;
    const nextManifests = await Promise.all(
      nextFiles.map((file, index) => createFileManifest(file, transferId, index)),
    );

    if (selectionSequence.current !== sequence) {
      return;
    }

    setSession({ files: nextFiles, manifests: nextManifests });
    saveOutgoingManifests(nextManifests, storageScope);
  }, [storageScope]);

  return {
    files,
    manifests,
    progress,
    selectFiles,
  };
}
