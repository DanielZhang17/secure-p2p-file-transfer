import type { ChunkAck, FileManifest } from "../../shared/protocol";
import {
  createPeerKeyPair,
  decryptChunk,
  deriveSharedTransferKeys,
  encryptChunk,
  type PeerKeyPair,
  verificationPhrase,
} from "./crypto";
import { verifyFileHash } from "./fileHash";
import { loadReceivedFile, saveReceivedChunk } from "./receivedChunkStore";
import { splitIntoFrames } from "../transport/frameProtocol";
import {
  isBoundedBase64,
  isSafeChunkIndex,
  isSafeFileManifest,
  isSafeIdentifier,
  MAX_ACTIVE_CHUNK_FRAME_ACCUMULATORS,
  MAX_ACTIVE_CHUNK_FRAME_BYTES,
  MAX_CHUNK_FRAME_BYTES,
  MAX_CHUNK_FRAME_COUNT,
  MAX_FILES_PER_TRANSFER,
  MAX_TRANSFER_KEY_EXCHANGES,
} from "../../shared/protocolValidation";

export type DataChannelTransferMessage =
  | { type: "key-exchange"; transferId: string; publicKeyBase64: string }
  | { type: "verification-confirmed"; transferId: string }
  | { type: "manifest"; manifest: FileManifest }
  | {
      type: "chunk";
      transferId: string;
      fileId: string;
      chunkIndex: number;
      ivBase64: string;
      ciphertextBase64: string;
    }
  | {
      type: "chunk-frame";
      transferId: string;
      fileId: string;
      chunkIndex: number;
      frameIndex: number;
      finalFrame: boolean;
      ivBase64: string;
      ciphertextBase64: string;
    };
export type EncryptedChunkTransferMessage = Extract<DataChannelTransferMessage, { type: "chunk" }>;
export type EncryptedChunkFrameTransferMessage = Extract<DataChannelTransferMessage, { type: "chunk-frame" }>;
export type ManifestTransferMessage = Extract<DataChannelTransferMessage, { type: "manifest" }>;
export type TransferKeyExchangeMessage = Extract<DataChannelTransferMessage, { type: "key-exchange" }>;

interface ChunkFrameAccumulator {
  byteLength: number;
  finalFrameIndex?: number;
  frames: Map<number, Uint8Array<ArrayBuffer>>;
  ivBase64: string;
}

export interface ReceivedChunkWriteInput {
  bytes: Uint8Array<ArrayBuffer>;
  chunkIndex: number;
  manifest: FileManifest;
}

export interface IncomingTransferState {
  completeReceivedFile?: (manifest: FileManifest) => Promise<void>;
  completedChunkMessages: EncryptedChunkTransferMessage[];
  chunks: Map<string, Map<number, Uint8Array<ArrayBuffer>>>;
  chunkFrames: Map<string, ChunkFrameAccumulator>;
  localKeyPairs: Map<string, PeerKeyPair>;
  manifests: Map<string, FileManifest>;
  peerPublicKeys: Map<string, string>;
  persistReceivedChunks: boolean;
  sentKeyExchangeIds: Set<string>;
  transferKeys: Map<string, CryptoKey>;
  verificationPhrases: Map<string, string>;
  writeReceivedChunk?: (input: ReceivedChunkWriteInput) => Promise<boolean>;
}

export interface IncomingTransferStateOptions {
  completeReceivedFile?: (manifest: FileManifest) => Promise<void>;
  persistReceivedChunks?: boolean;
  writeReceivedChunk?: (input: ReceivedChunkWriteInput) => Promise<boolean>;
}

export function createManifestMessage(manifest: FileManifest): ManifestTransferMessage {
  return { type: "manifest", manifest };
}

export async function createTransferKeyExchangeMessage(
  state: IncomingTransferState,
  transferId: string,
): Promise<TransferKeyExchangeMessage> {
  const keyPair = await ensureLocalKeyPair(state, transferId);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  state.sentKeyExchangeIds.add(transferId);

  return { type: "key-exchange", transferId, publicKeyBase64: bytesToBase64(publicKey) };
}

export function hasSentTransferKeyExchange(state: IncomingTransferState, transferId: string): boolean {
  return state.sentKeyExchangeIds.has(transferId);
}

export function getTransferContentKey(state: IncomingTransferState, transferId: string): CryptoKey | undefined {
  return state.transferKeys.get(transferId);
}

export function getTransferVerificationPhrase(state: IncomingTransferState, transferId: string): string | undefined {
  return state.verificationPhrases.get(transferId);
}

export async function createEncryptedChunkMessage(
  file: File,
  manifest: FileManifest,
  chunkIndex: number,
  contentKey: CryptoKey,
): Promise<DataChannelTransferMessage> {
  const offset = chunkIndex * manifest.chunkSize;
  const bytes = new Uint8Array(await file.slice(offset, offset + manifest.chunkSize).arrayBuffer());
  const encrypted = await encryptChunk(contentKey, bytes, manifest.fileId, chunkIndex);

  return {
    type: "chunk",
    transferId: manifest.transferId,
    fileId: manifest.fileId,
    chunkIndex,
    ivBase64: bytesToBase64(encrypted.iv),
    ciphertextBase64: bytesToBase64(encrypted.ciphertext),
  };
}

export function createEncryptedChunkFrameMessages(
  message: EncryptedChunkTransferMessage,
  frameSize: number,
): EncryptedChunkFrameTransferMessage[] {
  const ciphertext = base64ToBytes(message.ciphertextBase64);
  return splitIntoFrames({
    transferId: message.transferId,
    fileId: message.fileId,
    chunkIndex: message.chunkIndex,
    bytes: ciphertext,
    frameSize,
  }).map((frame) => ({
    type: "chunk-frame" as const,
    transferId: frame.transferId,
    fileId: frame.fileId,
    chunkIndex: frame.chunkIndex,
    frameIndex: frame.frameIndex,
    finalFrame: frame.finalFrame,
    ivBase64: message.ivBase64,
    ciphertextBase64: bytesToBase64(frame.bytes),
  }));
}

export async function createChunkAck(message: EncryptedChunkTransferMessage): Promise<ChunkAck> {
  const iv = base64ToBytes(message.ivBase64);
  const ciphertext = base64ToBytes(message.ciphertextBase64);
  const digest = await crypto.subtle.digest("SHA-256", concatBytes(iv, ciphertext));

  return {
    transferId: message.transferId,
    fileId: message.fileId,
    chunkIndex: message.chunkIndex,
    hash: toHex(new Uint8Array(digest)),
  };
}

export async function createTransferMessages(
  file: File,
  manifest: FileManifest,
  contentKey: CryptoKey,
): Promise<DataChannelTransferMessage[]> {
  const messages: DataChannelTransferMessage[] = [createManifestMessage(manifest)];

  for (let chunkIndex = 0; chunkIndex < manifest.chunkCount; chunkIndex += 1) {
    messages.push(await createEncryptedChunkMessage(file, manifest, chunkIndex, contentKey));
  }

  return messages;
}

export function createIncomingTransferState(options: IncomingTransferStateOptions = {}): IncomingTransferState {
  return {
    completeReceivedFile: options.completeReceivedFile,
    completedChunkMessages: [],
    chunks: new Map(),
    chunkFrames: new Map(),
    localKeyPairs: new Map(),
    manifests: new Map(),
    peerPublicKeys: new Map(),
    persistReceivedChunks: options.persistReceivedChunks === true,
    sentKeyExchangeIds: new Set(),
    transferKeys: new Map(),
    verificationPhrases: new Map(),
    writeReceivedChunk: options.writeReceivedChunk,
  };
}

export function consumeCompletedChunkMessages(state: IncomingTransferState): EncryptedChunkTransferMessage[] {
  return state.completedChunkMessages.splice(0);
}

export async function acceptTransferMessage(
  state: IncomingTransferState,
  message: DataChannelTransferMessage,
): Promise<File | undefined> {
  if (message.type === "key-exchange") {
    const existingPeerKey = state.peerPublicKeys.get(message.transferId);
    if (existingPeerKey && existingPeerKey !== message.publicKeyBase64) {
      throw new Error("transfer peer key changed");
    }
    if (existingPeerKey) {
      return undefined;
    }
    if (state.peerPublicKeys.size >= MAX_TRANSFER_KEY_EXCHANGES) {
      throw new Error("too many transfer key exchanges");
    }

    const keyPair = await ensureLocalKeyPair(state, message.transferId);
    const peerPublicKeyBytes = base64ToBytes(message.publicKeyBase64);
    const peerPublicKey = await crypto.subtle.importKey(
      "raw",
      peerPublicKeyBytes,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      [],
    );
    const keys = await deriveSharedTransferKeys(keyPair.privateKey, peerPublicKey, message.transferId);
    const localPublicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
    state.peerPublicKeys.set(message.transferId, message.publicKeyBase64);
    state.transferKeys.set(message.transferId, keys.contentKey);
    state.verificationPhrases.set(
      message.transferId,
      await verificationPhrase(keys.verificationKey, verificationTranscript(message.transferId, localPublicKeyBytes, peerPublicKeyBytes)),
    );
    return undefined;
  }

  if (message.type === "verification-confirmed") {
    return undefined;
  }

  if (message.type === "manifest") {
    const existingManifest = state.manifests.get(message.manifest.fileId);
    if (existingManifest && !sameManifest(existingManifest, message.manifest)) {
      throw new Error("transfer manifest changed");
    }
    if (!existingManifest && state.manifests.size >= MAX_FILES_PER_TRANSFER) {
      throw new Error("too many transfer manifests");
    }
    state.manifests.set(message.manifest.fileId, message.manifest);
    if (!state.chunks.has(message.manifest.fileId)) {
      state.chunks.set(message.manifest.fileId, new Map());
    }
    return undefined;
  }

  if (message.type === "chunk-frame") {
    const assembledChunk = acceptChunkFrame(state, message);
    if (!assembledChunk) {
      return undefined;
    }

    return acceptEncryptedChunkTransferMessage(state, assembledChunk);
  }

  return acceptEncryptedChunkTransferMessage(state, message);
}

async function acceptEncryptedChunkTransferMessage(
  state: IncomingTransferState,
  message: EncryptedChunkTransferMessage,
): Promise<File | undefined> {
  const manifest = state.manifests.get(message.fileId);
  const contentKey = state.transferKeys.get(message.transferId);
  if (!manifest || !contentKey || manifest.transferId !== message.transferId || message.chunkIndex >= manifest.chunkCount) {
    return undefined;
  }

  const completedChunks = state.chunks.get(message.fileId);
  if (completedChunks?.has(message.chunkIndex)) {
    return undefined;
  }

  const plaintext = await decryptChunk(
    contentKey,
    { iv: base64ToBytes(message.ivBase64), ciphertext: base64ToBytes(message.ciphertextBase64) },
    message.fileId,
    message.chunkIndex,
  );
  if (plaintext.byteLength !== expectedPlaintextBytes(manifest, message.chunkIndex)) {
    throw new Error("chunk size does not match manifest");
  }
  state.completedChunkMessages.push(message);

  if (state.writeReceivedChunk && (await state.writeReceivedChunk({ manifest, chunkIndex: message.chunkIndex, bytes: plaintext }))) {
    const chunks = state.chunks.get(message.fileId) ?? new Map<number, Uint8Array<ArrayBuffer>>();
    chunks.set(message.chunkIndex, new Uint8Array());
    state.chunks.set(message.fileId, chunks);
    if (chunks.size === manifest.chunkCount) {
      await state.completeReceivedFile?.(manifest);
    }
    return undefined;
  }

  if (state.persistReceivedChunks) {
    await saveReceivedChunk({ manifest, chunkIndex: message.chunkIndex, bytes: plaintext });
    const file = await loadReceivedFile(manifest);
    if (file) {
      await verifyFileHash(file, manifest);
    }
    return file;
  }

  const chunks = state.chunks.get(message.fileId) ?? new Map<number, Uint8Array<ArrayBuffer>>();
  chunks.set(message.chunkIndex, plaintext);
  state.chunks.set(message.fileId, chunks);

  if (chunks.size !== manifest.chunkCount) {
    return undefined;
  }

  const bytes = new Blob(
    Array.from({ length: manifest.chunkCount }, (_, index) => concreteArrayBuffer(chunks.get(index) ?? new Uint8Array())),
  );
  const file = new File([bytes], manifest.name, { type: manifest.type, lastModified: manifest.lastModified });
  await verifyFileHash(file, manifest);
  return file;
}

function acceptChunkFrame(
  state: IncomingTransferState,
  message: EncryptedChunkFrameTransferMessage,
): EncryptedChunkTransferMessage | undefined {
  const key = chunkFrameKey(message.transferId, message.fileId, message.chunkIndex);
  const manifest = state.manifests.get(message.fileId);
  if (!manifest || manifest.transferId !== message.transferId || message.chunkIndex >= manifest.chunkCount) {
    throw new Error("chunk frame has no matching manifest");
  }

  const existingAccumulator = state.chunkFrames.get(key);
  if (!existingAccumulator && state.chunkFrames.size >= MAX_ACTIVE_CHUNK_FRAME_ACCUMULATORS) {
    throw new Error("too many active chunk frame accumulators");
  }
  const accumulator = existingAccumulator ?? {
    byteLength: 0,
    frames: new Map<number, Uint8Array<ArrayBuffer>>(),
    ivBase64: message.ivBase64,
  };

  if (accumulator.ivBase64 !== message.ivBase64) {
    throw new Error("chunk frame IV mismatch");
  }

  if (message.frameIndex >= MAX_CHUNK_FRAME_COUNT) {
    throw new Error("too many chunk frames");
  }
  if (accumulator.finalFrameIndex !== undefined && message.frameIndex > accumulator.finalFrameIndex) {
    throw new Error("chunk frame follows final frame");
  }
  if (
    message.finalFrame &&
    (accumulator.finalFrameIndex !== undefined && accumulator.finalFrameIndex !== message.frameIndex ||
      Array.from(accumulator.frames.keys()).some((frameIndex) => frameIndex > message.frameIndex))
  ) {
    throw new Error("chunk final frame changed");
  }
  const frame = base64ToBytes(message.ciphertextBase64);
  const previousFrame = accumulator.frames.get(message.frameIndex);
  const nextByteLength = accumulator.byteLength - (previousFrame?.byteLength ?? 0) + frame.byteLength;
  if (nextByteLength > manifest.chunkSize + 16) {
    state.chunkFrames.delete(key);
    throw new Error("chunk frames exceed manifest size");
  }
  const nextActiveByteLength = activeChunkFrameBytes(state) - (previousFrame?.byteLength ?? 0) + frame.byteLength;
  if (nextActiveByteLength > MAX_ACTIVE_CHUNK_FRAME_BYTES) {
    throw new Error("active chunk frames exceed memory limit");
  }
  accumulator.byteLength = nextByteLength;
  accumulator.frames.set(message.frameIndex, frame);
  if (message.finalFrame) {
    accumulator.finalFrameIndex = message.frameIndex;
  }
  state.chunkFrames.set(key, accumulator);

  if (
    accumulator.finalFrameIndex === undefined ||
    accumulator.frames.size !== accumulator.finalFrameIndex + 1
  ) {
    return undefined;
  }

  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (let frameIndex = 0; frameIndex <= accumulator.finalFrameIndex; frameIndex += 1) {
    const frame = accumulator.frames.get(frameIndex);
    if (!frame) {
      return undefined;
    }
    parts.push(frame);
  }
  state.chunkFrames.delete(key);

  return {
    type: "chunk",
    transferId: message.transferId,
    fileId: message.fileId,
    chunkIndex: message.chunkIndex,
    ivBase64: message.ivBase64,
    ciphertextBase64: bytesToBase64(concatMany(parts)),
  };
}

export function parseDataChannelTransferMessage(payload: string): DataChannelTransferMessage | null {
  if (payload.length > Math.ceil(MAX_CHUNK_FRAME_BYTES / 3) * 4 + 4_096) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(payload);
    if (isDataChannelTransferMessage(parsed)) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

function isDataChannelTransferMessage(value: unknown): value is DataChannelTransferMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "manifest") {
    return isSafeFileManifest(value.manifest);
  }

  if (value.type === "key-exchange") {
    return isSafeIdentifier(value.transferId) && isBoundedBase64(value.publicKeyBase64, 128);
  }

  if (value.type === "verification-confirmed") {
    return isSafeIdentifier(value.transferId);
  }

  if (value.type === "chunk-frame") {
    const frameIndex = value.frameIndex;
    return (
      isSafeIdentifier(value.transferId) &&
      isSafeIdentifier(value.fileId) &&
      isSafeChunkIndex(value.chunkIndex) &&
      typeof frameIndex === "number" &&
      Number.isInteger(frameIndex) &&
      frameIndex >= 0 &&
      typeof value.finalFrame === "boolean" &&
      isBoundedBase64(value.ivBase64, 12) &&
      isBoundedBase64(value.ciphertextBase64, MAX_CHUNK_FRAME_BYTES)
    );
  }

  return (
    value.type === "chunk" &&
    isSafeIdentifier(value.transferId) &&
    isSafeIdentifier(value.fileId) &&
    isSafeChunkIndex(value.chunkIndex) &&
    isBoundedBase64(value.ivBase64, 12) &&
    isBoundedBase64(value.ciphertextBase64, MAX_CHUNK_FRAME_BYTES)
  );
}

async function ensureLocalKeyPair(state: IncomingTransferState, transferId: string): Promise<PeerKeyPair> {
  const existing = state.localKeyPairs.get(transferId);
  if (existing) {
    return existing;
  }

  const keyPair = await createPeerKeyPair();
  state.localKeyPairs.set(transferId, keyPair);

  return keyPair;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function concreteArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function concatBytes(left: Uint8Array<ArrayBuffer>, right: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left, 0);
  combined.set(right, left.byteLength);

  return combined;
}

function concatMany(parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const totalBytes = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }

  return combined;
}

function chunkFrameKey(transferId: string, fileId: string, chunkIndex: number): string {
  return `${transferId}:${fileId}:${chunkIndex}`;
}

function expectedPlaintextBytes(manifest: FileManifest, chunkIndex: number): number {
  const offset = chunkIndex * manifest.chunkSize;
  return Math.max(0, Math.min(manifest.chunkSize, manifest.size - offset));
}

function activeChunkFrameBytes(state: IncomingTransferState): number {
  let total = 0;
  for (const accumulator of state.chunkFrames.values()) {
    total += accumulator.byteLength;
  }
  return total;
}

function sameManifest(left: FileManifest, right: FileManifest): boolean {
  return (
    left.transferId === right.transferId &&
    left.fileId === right.fileId &&
    left.name === right.name &&
    left.type === right.type &&
    left.size === right.size &&
    left.lastModified === right.lastModified &&
    left.chunkSize === right.chunkSize &&
    left.chunkCount === right.chunkCount &&
    left.fileHash === right.fileHash
  );
}

function verificationTranscript(
  transferId: string,
  localPublicKey: Uint8Array<ArrayBuffer>,
  peerPublicKey: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const [firstKey, secondKey] = compareBytes(localPublicKey, peerPublicKey) <= 0
    ? [localPublicKey, peerPublicKey]
    : [peerPublicKey, localPublicKey];
  const transferBytes = new TextEncoder().encode(transferId);
  return concatMany([transferBytes, firstKey, secondKey]);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return left.length - right.length;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
