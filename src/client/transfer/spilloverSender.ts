import type { ChunkAck, ClientRoomMessage, FileManifest } from "../../shared/protocol";
import { selectChunkProfile } from "./chunkProfile";
import { createChunkAck, createEncryptedChunkMessage, createManifestMessage } from "./dataChannelTransfer";
import { scheduleChunks } from "./scheduler";
import { uploadSpilloverChunk, type SpilloverCredentials } from "./spilloverClient";

export interface SpilloverSendProgress {
  activeLanes: number;
  completedChunks: number;
  retryCount: number;
  sentBytes: number;
  spilloverBytes: number;
}

export interface SendSpilloverTransferFilesInput {
  credentials: SpilloverCredentials;
  contentKeyForTransfer: (transferId: string) => Promise<CryptoKey>;
  files: File[];
  isChunkComplete?: (manifest: FileManifest, chunkIndex: number) => boolean;
  manifests: FileManifest[];
  maxRetries?: number;
  onExpectedAck?: (ack: ChunkAck) => void;
  onProgress?: (progress: SpilloverSendProgress) => void;
  sendRoomMessage: (message: ClientRoomMessage) => void;
}

const DEFAULT_MAX_RETRIES = 3;

export async function sendSpilloverTransferFiles(
  input: SendSpilloverTransferFilesInput,
): Promise<SpilloverSendProgress> {
  const progress: SpilloverSendProgress = {
    activeLanes: 0,
    completedChunks: 0,
    retryCount: 0,
    sentBytes: 0,
    spilloverBytes: 0,
  };

  const publishProgress = () => input.onProgress?.({ ...progress });

  for (const [index, file] of input.files.entries()) {
    const manifest = input.manifests[index];
    if (!manifest) {
      continue;
    }

    const contentKey = await input.contentKeyForTransfer(manifest.transferId);

    input.sendRoomMessage({ type: "transfer", message: createManifestMessage(manifest) });

    const profile = selectChunkProfile(file.size);
    const chunkIndexes = Array.from({ length: manifest.chunkCount }, (_, chunkIndex) => chunkIndex);
    const missingChunkIndexes = chunkIndexes.filter((chunkIndex) => !input.isChunkComplete?.(manifest, chunkIndex));
    progress.completedChunks += chunkIndexes.length - missingChunkIndexes.length;
    progress.activeLanes = profile.lanes;
    publishProgress();

    await scheduleChunks({
      adaptive: true,
      chunkIndexes: missingChunkIndexes,
      lanes: profile.lanes,
      maxRetries: input.maxRetries ?? DEFAULT_MAX_RETRIES,
      onLaneCountChange: (lanes) => {
        progress.activeLanes = lanes;
        publishProgress();
      },
      onRetry: () => {
        progress.retryCount += 1;
        publishProgress();
      },
      sendChunk: async (chunkIndex) => {
        const message = await createEncryptedChunkMessage(file, manifest, chunkIndex, contentKey);
        if (message.type !== "chunk") {
          throw new Error("expected encrypted chunk message");
        }

        const ack = await createChunkAck(message);
        const chunk = await uploadSpilloverChunk(input.credentials, message);
        input.onExpectedAck?.(ack);
        input.sendRoomMessage({ type: "spillover-chunk", chunk });
        progress.completedChunks += 1;
        progress.sentBytes += chunk.ciphertextBytes;
        progress.spilloverBytes += chunk.ciphertextBytes;
        publishProgress();
      },
    });
  }

  progress.activeLanes = 0;
  publishProgress();

  return progress;
}
