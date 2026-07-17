import type { EncryptedChunkTransferMessage } from "./dataChannelTransfer";

export interface SpilloverCredentials {
  roomId: string;
  recoveryToken: string;
}

export interface SpilloverChunkRef {
  transferId: string;
  fileId: string;
  chunkIndex: number;
  ivBase64: string;
  ciphertextBytes: number;
}

interface UploadSpilloverChunkResponse extends SpilloverChunkRef {
  expiresAt: number;
}

export async function uploadSpilloverChunk(
  credentials: SpilloverCredentials,
  message: EncryptedChunkTransferMessage,
): Promise<SpilloverChunkRef> {
  const ciphertext = base64ToBytes(message.ciphertextBase64);
  const response = await fetch(spilloverChunkUrl(credentials.roomId, message), {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "x-recovery-token": credentials.recoveryToken,
      "x-spillover-iv": message.ivBase64,
    },
    body: concreteArrayBuffer(ciphertext),
  });

  if (!response.ok) {
    throw new Error("spillover upload failed");
  }

  const body: unknown = await response.json();
  if (!isUploadSpilloverChunkResponse(body)) {
    throw new Error("spillover upload response is invalid");
  }

  return {
    transferId: body.transferId,
    fileId: body.fileId,
    chunkIndex: body.chunkIndex,
    ivBase64: body.ivBase64,
    ciphertextBytes: body.ciphertextBytes,
  };
}

export async function downloadSpilloverChunk(
  credentials: SpilloverCredentials,
  chunk: SpilloverChunkRef,
): Promise<EncryptedChunkTransferMessage> {
  const response = await fetch(spilloverChunkUrl(credentials.roomId, chunk), {
    headers: { "x-recovery-token": credentials.recoveryToken },
  });

  if (!response.ok) {
    throw new Error("spillover download failed");
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  return {
    type: "chunk",
    transferId: chunk.transferId,
    fileId: chunk.fileId,
    chunkIndex: chunk.chunkIndex,
    ivBase64: response.headers.get("x-spillover-iv") || chunk.ivBase64,
    ciphertextBase64: bytesToBase64(bytes),
  };
}

export async function deleteSpilloverChunk(
  credentials: SpilloverCredentials,
  chunk: SpilloverChunkRef,
): Promise<void> {
  const response = await fetch(spilloverChunkUrl(credentials.roomId, chunk), {
    method: "DELETE",
    headers: { "x-recovery-token": credentials.recoveryToken },
  });

  if (!response.ok) {
    throw new Error("spillover delete failed");
  }
}

function spilloverChunkUrl(
  roomId: string,
  chunk: Pick<SpilloverChunkRef, "transferId" | "fileId" | "chunkIndex">,
): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/spillover/${encodeURIComponent(chunk.transferId)}/${encodeURIComponent(
    chunk.fileId,
  )}/${chunk.chunkIndex}`;
}

function isUploadSpilloverChunkResponse(value: unknown): value is UploadSpilloverChunkResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "transferId" in value &&
    "fileId" in value &&
    "chunkIndex" in value &&
    "ivBase64" in value &&
    "ciphertextBytes" in value &&
    "expiresAt" in value &&
    typeof value.transferId === "string" &&
    typeof value.fileId === "string" &&
    typeof value.chunkIndex === "number" &&
    typeof value.ivBase64 === "string" &&
    typeof value.ciphertextBytes === "number" &&
    typeof value.expiresAt === "number"
  );
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return btoa(binary);
}

function concreteArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
