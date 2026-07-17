import { describe, expect, it, vi } from "vitest";
import type { FileManifest } from "../../shared/protocol";
import { ReceivedFileStreamWriter, type FileSystemDirectoryHandleLike } from "./receivedFileStream";

describe("ReceivedFileStreamWriter", () => {
  it("writes decrypted chunks to a file handle at chunk offsets and verifies on close", async () => {
    const temporaryWrites: Array<{ position: number; text: string }> = [];
    const destinationWrites: Array<{ position: number; text: string }> = [];
    const temporaryWritable = {
      close: vi.fn(async () => {}),
      write: vi.fn(async ({ position, data }: { position: number; data: ArrayBuffer }) => {
        temporaryWrites.push({ position, text: new TextDecoder().decode(data) });
      }),
    };
    const destinationWritable = {
      close: vi.fn(async () => {}),
      write: vi.fn(async ({ position, data }: { position: number; data: ArrayBuffer }) => {
        destinationWrites.push({ position, text: new TextDecoder().decode(data) });
      }),
    };
    const removeEntry = vi.fn(async () => {});
    const directory: FileSystemDirectoryHandleLike = {
      getFileHandle: vi.fn(async (name, options) => {
        if (options?.create === false) {
          throw new DOMException("missing", "NotFoundError");
        }
        if (name.endsWith(".part")) {
          return {
            createWritable: async () => temporaryWritable,
            getFile: async () => new File(["onetwo"], name),
          };
        }
        return { createWritable: async () => destinationWritable };
      }),
      removeEntry,
    };
    const manifest: FileManifest = {
      transferId: "transfer-1",
      fileId: "file-1",
      name: "joined.txt",
      size: 6,
      type: "text/plain",
      lastModified: 1_700_000_000_000,
      chunkSize: 3,
      chunkCount: 2,
      fileHash: "25b6746d5172ed6352966a013d93ac846e1110d5a25e8f183b5931f4688842a1",
    };
    const writer = new ReceivedFileStreamWriter(directory);

    await writer.writeChunk({ manifest, chunkIndex: 1, bytes: new TextEncoder().encode("two") as Uint8Array<ArrayBuffer> });
    await writer.writeChunk({ manifest, chunkIndex: 0, bytes: new TextEncoder().encode("one") as Uint8Array<ArrayBuffer> });
    await writer.complete(manifest);

    expect(directory.getFileHandle).toHaveBeenCalledWith("joined.txt", { create: false });
    expect(directory.getFileHandle).toHaveBeenCalledWith("joined.txt", { create: true });
    expect(temporaryWrites).toEqual([
      { position: 3, text: "two" },
      { position: 0, text: "one" },
    ]);
    expect(destinationWrites).toEqual([{ position: 0, text: "onetwo" }]);
    expect(temporaryWritable.close).toHaveBeenCalledOnce();
    expect(destinationWritable.close).toHaveBeenCalledOnce();
    expect(removeEntry).toHaveBeenCalledWith(expect.stringMatching(/^\.secure-p2p-.*\.part$/));
  });

  it("does not publish a final file when whole-file verification fails", async () => {
    const writable = {
      close: vi.fn(async () => {}),
      write: vi.fn(async () => {}),
    };
    const removeEntry = vi.fn(async () => {});
    const getFileHandle = vi.fn(async (name: string) => ({
      createWritable: async () => writable,
      getFile: async () => new File(["tampered"], name),
    }));
    const writer = new ReceivedFileStreamWriter({ getFileHandle, removeEntry });
    const manifest: FileManifest = {
      transferId: "transfer-1",
      fileId: "file-1",
      name: "joined.txt",
      size: 6,
      type: "text/plain",
      lastModified: 1_700_000_000_000,
      chunkSize: 6,
      chunkCount: 1,
      fileHash: "25b6746d5172ed6352966a013d93ac846e1110d5a25e8f183b5931f4688842a1",
    };

    await writer.writeChunk({ manifest, chunkIndex: 0, bytes: new TextEncoder().encode("broken") as Uint8Array<ArrayBuffer> });
    await expect(writer.complete(manifest)).rejects.toThrow("file hash mismatch");

    expect(getFileHandle).toHaveBeenCalledTimes(1);
    expect(removeEntry).toHaveBeenCalledWith(expect.stringMatching(/^\.secure-p2p-.*\.part$/));
  });

  it("chooses a unique destination instead of overwriting an existing peer-named file", async () => {
    const temporaryWritable = { close: vi.fn(async () => {}), write: vi.fn(async () => {}) };
    const destinationWritable = { close: vi.fn(async () => {}), write: vi.fn(async () => {}) };
    const getFileHandle = vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (options?.create === false && name === "report.txt") {
        return { createWritable: async () => destinationWritable };
      }
      if (options?.create === false) {
        throw new DOMException("missing", "NotFoundError");
      }
      if (name.endsWith(".part")) {
        return {
          createWritable: async () => temporaryWritable,
          getFile: async () => new File(["safe"], name),
        };
      }
      return { createWritable: async () => destinationWritable };
    });
    const writer = new ReceivedFileStreamWriter({ getFileHandle, removeEntry: vi.fn(async () => {}) });
    const manifest: FileManifest = {
      transferId: "transfer-1",
      fileId: "file-1",
      name: "report.txt",
      size: 4,
      type: "text/plain",
      lastModified: 1,
      chunkSize: 4,
      chunkCount: 1,
    };

    await writer.writeChunk({ manifest, chunkIndex: 0, bytes: new TextEncoder().encode("safe") as Uint8Array<ArrayBuffer> });
    await writer.complete(manifest);

    expect(getFileHandle).toHaveBeenCalledWith("report.txt", { create: false });
    expect(getFileHandle).toHaveBeenCalledWith("report (1).txt", { create: true });
  });
});
