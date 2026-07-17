import { LARGE_FILE_CHUNK_BYTES } from "./limits";
import type { ChunkAck, FileManifest, SpilloverChunkRef } from "./protocol";

export const MAX_FILES_PER_TRANSFER = 1_024;
export const MAX_CHUNKS_PER_FILE = 1_000_000;
export const MAX_IDENTIFIER_LENGTH = 128;
export const MAX_FILE_NAME_LENGTH = 255;
export const MAX_MIME_TYPE_LENGTH = 255;
export const MAX_SIGNAL_SDP_LENGTH = 64 * 1024;
export const MAX_ROOM_MESSAGE_LENGTH = 128 * 1024;
export const MAX_TRANSFER_KEY_EXCHANGES = 8;
export const MAX_CHUNK_FRAME_COUNT = 128;
export const MAX_CHUNK_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_ACTIVE_CHUNK_FRAME_ACCUMULATORS = 32;
export const MAX_ACTIVE_CHUNK_FRAME_BYTES = 128 * 1024 * 1024;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isSafeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    IDENTIFIER_PATTERN.test(value)
  );
}

export function isSafeFileManifest(value: unknown): value is FileManifest {
  if (!isRecord(value)) {
    return false;
  }

  const { chunkCount, chunkSize, fileHash, fileId, lastModified, name, size, transferId, type } = value;
  if (
    !isSafeIdentifier(transferId) ||
    !isSafeIdentifier(fileId) ||
    !isSafeFileName(name) ||
    typeof type !== "string" ||
    type.length > MAX_MIME_TYPE_LENGTH ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof lastModified !== "number" ||
    !Number.isFinite(lastModified) ||
    lastModified < 0 ||
    typeof chunkSize !== "number" ||
    !Number.isSafeInteger(chunkSize) ||
    chunkSize < 1 ||
    chunkSize > LARGE_FILE_CHUNK_BYTES ||
    typeof chunkCount !== "number" ||
    !Number.isSafeInteger(chunkCount) ||
    chunkCount < 1 ||
    chunkCount > MAX_CHUNKS_PER_FILE ||
    chunkCount !== Math.max(1, Math.ceil(size / chunkSize))
  ) {
    return false;
  }

  return fileHash === undefined || (typeof fileHash === "string" && SHA256_PATTERN.test(fileHash));
}

export function isSafeChunkAck(value: unknown): value is ChunkAck {
  return (
    isRecord(value) &&
    isSafeIdentifier(value.transferId) &&
    isSafeIdentifier(value.fileId) &&
    isSafeChunkIndex(value.chunkIndex) &&
    typeof value.hash === "string" &&
    SHA256_PATTERN.test(value.hash)
  );
}

export function isSafeSpilloverChunkRef(value: unknown): value is SpilloverChunkRef {
  return (
    isRecord(value) &&
    isSafeIdentifier(value.transferId) &&
    isSafeIdentifier(value.fileId) &&
    isSafeChunkIndex(value.chunkIndex) &&
    isBase64OfDecodedLength(value.ivBase64, 12) &&
    typeof value.ciphertextBytes === "number" &&
    Number.isSafeInteger(value.ciphertextBytes) &&
    value.ciphertextBytes >= 0 &&
    value.ciphertextBytes <= LARGE_FILE_CHUNK_BYTES + 16
  );
}

export function isSafeChunkIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < MAX_CHUNKS_PER_FILE;
}

export function isBoundedBase64(value: unknown, maxDecodedBytes: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(maxDecodedBytes / 3) * 4) {
    return false;
  }

  return value.length % 4 === 0 && BASE64_PATTERN.test(value);
}

export function isBase64OfDecodedLength(value: unknown, decodedBytes: number): value is string {
  if (!isBoundedBase64(value, decodedBytes)) {
    return false;
  }

  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length * 3) / 4 - padding === decodedBytes;
}

function isSafeFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_FILE_NAME_LENGTH &&
    value !== "." &&
    value !== ".." &&
    !/[\0-\x1f/\\]/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
