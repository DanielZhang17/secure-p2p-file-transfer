import type { FileManifest } from "../../shared/protocol";
import { verifyFileHash } from "./fileHash";
import type { ReceivedChunkWriteInput } from "./dataChannelTransfer";

export interface FileSystemWritableLike {
  close: () => Promise<void>;
  write: (data: { type: "write"; position: number; data: ArrayBuffer }) => Promise<void>;
}

export interface FileSystemFileHandleLike {
  createWritable: () => Promise<FileSystemWritableLike>;
  getFile?: () => Promise<File>;
}

export interface FileSystemDirectoryHandleLike {
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<FileSystemFileHandleLike>;
  removeEntry: (name: string) => Promise<void>;
}

interface StreamEntry {
  fileHandle: FileSystemFileHandleLike;
  temporaryName: string;
  writable: FileSystemWritableLike;
}

const COPY_CHUNK_BYTES = 8 * 1024 * 1024;

export class ReceivedFileStreamWriter {
  private readonly entries = new Map<string, StreamEntry>();

  constructor(private readonly directory: FileSystemDirectoryHandleLike) {}

  async writeChunk(input: ReceivedChunkWriteInput): Promise<boolean> {
    const expectedBytes = expectedPlaintextBytes(input.manifest, input.chunkIndex);
    if (expectedBytes < 0 || input.bytes.byteLength !== expectedBytes) {
      throw new Error("chunk does not match manifest geometry");
    }

    const entry = await this.entryFor(input.manifest);
    await entry.writable.write({
      type: "write",
      position: input.chunkIndex * input.manifest.chunkSize,
      data: concreteArrayBuffer(input.bytes),
    });

    return true;
  }

  async complete(manifest: FileManifest): Promise<void> {
    const entry = this.entries.get(manifest.fileId);
    if (!entry) {
      return;
    }

    this.entries.delete(manifest.fileId);
    try {
      await entry.writable.close();
      if (!entry.fileHandle.getFile) {
        throw new Error("temporary file cannot be verified");
      }

      const temporaryFile = await entry.fileHandle.getFile();
      await verifyFileHash(temporaryFile, manifest);
      const destinationName = await this.availableName(manifest.name);
      const destinationHandle = await this.directory.getFileHandle(destinationName, { create: true });
      const destination = await destinationHandle.createWritable();
      try {
        for (let offset = 0; offset < temporaryFile.size; offset += COPY_CHUNK_BYTES) {
          await destination.write({
            type: "write",
            position: offset,
            data: await temporaryFile.slice(offset, offset + COPY_CHUNK_BYTES).arrayBuffer(),
          });
        }
        await destination.close();
      } catch (error) {
        await this.directory.removeEntry(destinationName).catch(() => undefined);
        throw error;
      }
    } finally {
      await this.directory.removeEntry(entry.temporaryName).catch(() => undefined);
    }
  }

  private async entryFor(manifest: FileManifest): Promise<StreamEntry> {
    const existing = this.entries.get(manifest.fileId);
    if (existing) {
      return existing;
    }

    const temporaryName = `.secure-p2p-${crypto.randomUUID()}.part`;
    const fileHandle = await this.directory.getFileHandle(temporaryName, { create: true });
    const writable = await fileHandle.createWritable();
    const entry = { fileHandle, temporaryName, writable };
    this.entries.set(manifest.fileId, entry);

    return entry;
  }

  private async availableName(requestedName: string): Promise<string> {
    for (let suffix = 0; suffix < 10_000; suffix += 1) {
      const candidate = suffix === 0 ? requestedName : fileNameWithSuffix(requestedName, suffix);
      try {
        await this.directory.getFileHandle(candidate, { create: false });
      } catch (error) {
        if (isNotFoundError(error)) {
          return candidate;
        }
        throw error;
      }
    }

    throw new Error("no safe destination filename is available");
  }
}

function concreteArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function fileNameWithSuffix(name: string, suffix: number): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return `${name} (${suffix})`;
  }

  return `${name.slice(0, dot)} (${suffix})${name.slice(dot)}`;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException ? error.name === "NotFoundError" : error instanceof Error && error.name === "NotFoundError";
}

function expectedPlaintextBytes(manifest: FileManifest, chunkIndex: number): number {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= manifest.chunkCount) {
    return -1;
  }

  const offset = chunkIndex * manifest.chunkSize;
  return Math.max(0, Math.min(manifest.chunkSize, manifest.size - offset));
}
