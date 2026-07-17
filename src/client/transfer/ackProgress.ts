import type { ChunkAck, FileManifest } from "../../shared/protocol";
import { createChunkBitmap, markChunkComplete } from "./bitmap";
import { loadProgress, saveProgress } from "./progressStore";
import { isSafeChunkAck, isSafeFileManifest } from "../../shared/protocolValidation";

export interface SaveChunkAckProgressInput {
  ack: ChunkAck;
  expiresAt: number;
  manifest: FileManifest;
  recoveryToken: string;
}

export async function saveChunkAckProgress(input: SaveChunkAckProgressInput): Promise<void> {
  if (
    !isSafeFileManifest(input.manifest) ||
    !isSafeChunkAck(input.ack) ||
    input.ack.chunkIndex >= input.manifest.chunkCount ||
    input.ack.transferId !== input.manifest.transferId ||
    input.ack.fileId !== input.manifest.fileId
  ) {
    return;
  }

  const previous = await loadProgress(input.manifest.transferId, input.manifest.fileId);
  const completed =
    previous?.completed.length === input.manifest.chunkCount
      ? previous.completed
      : createChunkBitmap(input.manifest.chunkCount).completed;
  const bitmap = markChunkComplete({ totalChunks: input.manifest.chunkCount, completed }, input.ack.chunkIndex);
  const ackHashes =
    previous?.ackHashes?.length === input.manifest.chunkCount
      ? previous.ackHashes.slice()
      : Array.from({ length: input.manifest.chunkCount }, () => "");
  ackHashes[input.ack.chunkIndex] = input.ack.hash;

  await saveProgress({
    transferId: input.manifest.transferId,
    fileId: input.manifest.fileId,
    completed: bitmap.completed,
    ackHashes,
    recoveryToken: input.recoveryToken,
    expiresAt: input.expiresAt,
  });
}

export async function loadCompletedChunkIndexes(
  manifest: FileManifest,
  recoveryToken: string,
): Promise<Set<number>> {
  const progress = await loadProgress(manifest.transferId, manifest.fileId);
  const completed = new Set<number>();

  if (!progress || progress.recoveryToken !== recoveryToken) {
    return completed;
  }

  for (let index = 0; index < Math.min(progress.completed.length, manifest.chunkCount); index += 1) {
    if (progress.completed[index]) {
      completed.add(index);
    }
  }

  return completed;
}

export async function loadChunkAckHashes(
  manifest: FileManifest,
  recoveryToken: string,
): Promise<Map<number, string>> {
  const progress = await loadProgress(manifest.transferId, manifest.fileId);
  const hashes = new Map<number, string>();

  if (!progress || progress.recoveryToken !== recoveryToken || !progress.ackHashes) {
    return hashes;
  }

  for (let index = 0; index < Math.min(progress.ackHashes.length, manifest.chunkCount); index += 1) {
    const hash = progress.ackHashes[index];
    if (hash) {
      hashes.set(index, hash);
    }
  }

  return hashes;
}
