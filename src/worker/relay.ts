import { isBase64OfDecodedLength } from "../shared/protocolValidation";
import { ROOM_ID_PATTERN } from "../shared/roomCode";

const DECIMAL_INTEGER_PATTERN = /^[0-9]+$/;
const SAFE_SPILLOVER_SEGMENT_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface SpilloverChunkLocation {
  roomId: string;
  transferId: string;
  fileId: string;
  chunkIndex: number;
}

export function assertRelayRequestAllowed(contentLength: number, maxBytes: number): void {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || !Number.isInteger(maxBytes)) {
    throw new Error("relay limit is not configured");
  }

  if (!Number.isFinite(contentLength) || contentLength < 0) {
    throw new Error("content length is required");
  }

  if (contentLength > maxBytes) {
    throw new Error("relay request exceeds configured limit");
  }
}

export function parseRelayContentLength(value: string | null): number {
  return parseStrictDecimalInteger(value, "content length is required");
}

export function parseRelayMaxBytes(value: string | null): number {
  return parseStrictDecimalInteger(value, "relay limit is not configured");
}

export function parseSpilloverChunkPath(pathname: string): SpilloverChunkLocation | null {
  const match = /^\/api\/rooms\/([^/]+)\/spillover\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match) {
    return null;
  }

  const [, encodedRoomId, encodedTransferId, encodedFileId, encodedChunkIndex] = match;
  const roomId = decodeURIComponent(encodedRoomId);
  const transferId = decodeURIComponent(encodedTransferId);
  const fileId = decodeURIComponent(encodedFileId);
  const chunkIndexValue = decodeURIComponent(encodedChunkIndex);

  if (
    !ROOM_ID_PATTERN.test(roomId) ||
    !isSafeSpilloverSegment(transferId) ||
    !isSafeSpilloverSegment(fileId) ||
    !DECIMAL_INTEGER_PATTERN.test(chunkIndexValue)
  ) {
    return null;
  }

  const chunkIndex = Number(chunkIndexValue);
  if (!Number.isSafeInteger(chunkIndex)) {
    return null;
  }

  return { roomId, transferId, fileId, chunkIndex };
}

export function spilloverObjectKey(location: SpilloverChunkLocation): string {
  return `rooms/${location.roomId}/${location.transferId}/${location.fileId}/${location.chunkIndex}`;
}

export function parseSpilloverIv(value: string | null): string {
  if (!isBase64OfDecodedLength(value, 12)) {
    throw new Error("spillover iv is required");
  }

  return value;
}

function parseStrictDecimalInteger(value: string | null, errorMessage: string): number {
  if (value === null || !DECIMAL_INTEGER_PATTERN.test(value)) {
    throw new Error(errorMessage);
  }

  return Number(value);
}

function isSafeSpilloverSegment(value: string): boolean {
  return SAFE_SPILLOVER_SEGMENT_PATTERN.test(value);
}
