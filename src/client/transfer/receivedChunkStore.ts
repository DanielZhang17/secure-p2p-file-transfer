import type { FileManifest } from "../../shared/protocol";
import {
  openTransferDb,
  RECEIVED_CHUNKS_STORE_NAME,
  requestToPromise,
  transactionToPromise,
} from "./transferDb";

export interface SaveReceivedChunkInput {
  bytes: Uint8Array<ArrayBuffer>;
  chunkIndex: number;
  manifest: FileManifest;
}

interface StoredReceivedChunk {
  bytes: ArrayBuffer;
  chunkIndex: number;
  fileId: string;
  transferId: string;
}

export async function saveReceivedChunk(input: SaveReceivedChunkInput): Promise<void> {
  validateChunkIndex(input.manifest, input.chunkIndex);
  const offset = input.chunkIndex * input.manifest.chunkSize;
  const expectedBytes = Math.max(0, Math.min(input.manifest.chunkSize, input.manifest.size - offset));
  if (input.bytes.byteLength !== expectedBytes) {
    throw new Error("chunk does not match manifest geometry");
  }
  const db = await openTransferDb();

  try {
    const transaction = db.transaction(RECEIVED_CHUNKS_STORE_NAME, "readwrite");
    transaction.objectStore(RECEIVED_CHUNKS_STORE_NAME).put(
      {
        transferId: input.manifest.transferId,
        fileId: input.manifest.fileId,
        chunkIndex: input.chunkIndex,
        bytes: concreteArrayBuffer(input.bytes),
      } satisfies StoredReceivedChunk,
      keyFor(input.manifest.transferId, input.manifest.fileId, input.chunkIndex),
    );
    await transactionToPromise(transaction);
  } finally {
    db.close();
  }
}

export async function loadReceivedFile(manifest: FileManifest): Promise<File | undefined> {
  const db = await openTransferDb();

  try {
    const transaction = db.transaction(RECEIVED_CHUNKS_STORE_NAME, "readonly");
    const store = transaction.objectStore(RECEIVED_CHUNKS_STORE_NAME);
    const parts: ArrayBuffer[] = [];

    for (let chunkIndex = 0; chunkIndex < manifest.chunkCount; chunkIndex += 1) {
      const chunk = await requestToPromise<StoredReceivedChunk | undefined>(
        store.get(keyFor(manifest.transferId, manifest.fileId, chunkIndex)),
      );
      if (!chunk) {
        return undefined;
      }

      parts.push(chunk.bytes);
    }

    return new File(parts, manifest.name, { type: manifest.type, lastModified: manifest.lastModified });
  } finally {
    db.close();
  }
}

function keyFor(transferId: string, fileId: string, chunkIndex: number): [string, string, number] {
  return [transferId, fileId, chunkIndex];
}

function validateChunkIndex(manifest: FileManifest, chunkIndex: number): void {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= manifest.chunkCount) {
    throw new Error("chunk index out of range");
  }
}

function concreteArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
