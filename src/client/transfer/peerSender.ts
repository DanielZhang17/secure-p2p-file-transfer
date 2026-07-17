import { DEFAULT_RELAY_SUBFRAME_BYTES } from "../../shared/limits";
import type { ChunkAck, FileManifest } from "../../shared/protocol";
import { selectChunkProfile } from "./chunkProfile";
import {
  createChunkAck,
  createEncryptedChunkMessage,
  createEncryptedChunkFrameMessages,
  createManifestMessage,
} from "./dataChannelTransfer";
import { scheduleChunks } from "./scheduler";

export interface PeerSendProgress {
  activeLanes: number;
  completedChunks: number;
  retryCount: number;
  sentBytes: number;
}

export interface SendPeerTransferFilesInput {
  channel: RTCDataChannel;
  contentKeyForTransfer: (transferId: string) => Promise<CryptoKey>;
  files: File[];
  isChunkComplete?: (manifest: FileManifest, chunkIndex: number) => boolean;
  manifests: FileManifest[];
  maxRetries?: number;
  onExpectedAck?: (ack: ChunkAck) => void;
  onProgress?: (progress: PeerSendProgress) => void;
}

const DEFAULT_MAX_RETRIES = 3;

export async function sendPeerTransferFiles(input: SendPeerTransferFilesInput): Promise<PeerSendProgress> {
  const progress: PeerSendProgress = {
    activeLanes: 0,
    completedChunks: 0,
    retryCount: 0,
    sentBytes: 0,
  };

  const publishProgress = () => input.onProgress?.({ ...progress });

  for (const [index, file] of input.files.entries()) {
    const manifest = input.manifests[index];
    if (!manifest) {
      continue;
    }

    const contentKey = await input.contentKeyForTransfer(manifest.transferId);

    sendJson(input.channel, createManifestMessage(manifest));

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
        const frames = createEncryptedChunkFrameMessages(message, profile.subframeSize);
        for (const frame of frames) {
          await waitForBufferedAmountLow(input.channel);
          sendJson(input.channel, frame);
        }
        input.onExpectedAck?.(ack);
        progress.completedChunks += 1;
        progress.sentBytes += base64PayloadSize(message.ciphertextBase64);
        publishProgress();
      },
    });
  }

  progress.activeLanes = 0;
  publishProgress();

  return progress;
}

function sendJson(channel: RTCDataChannel, message: unknown): void {
  if (channel.readyState !== "open") {
    throw new Error("peer data channel is not open");
  }

  channel.send(JSON.stringify(message));
}

function waitForBufferedAmountLow(channel: RTCDataChannel): Promise<void> {
  const bufferedAmount = typeof channel.bufferedAmount === "number" ? channel.bufferedAmount : 0;
  if (bufferedAmount <= DEFAULT_RELAY_SUBFRAME_BYTES) {
    return Promise.resolve();
  }

  channel.bufferedAmountLowThreshold = DEFAULT_RELAY_SUBFRAME_BYTES;

  return new Promise((resolve) => {
    channel.addEventListener("bufferedamountlow", () => resolve(), { once: true });
  });
}

function base64PayloadSize(base64: string): number {
  if (base64.length === 0) {
    return 0;
  }

  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}
