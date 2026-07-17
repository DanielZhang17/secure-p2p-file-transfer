import { describe, expect, it } from "vitest";
import { GiB, LARGE_FILE_CHUNK_BYTES } from "../../shared/limits";
import { createFileManifest } from "./manifest";

describe("createFileManifest", () => {
  it("creates deterministic metadata for a small selected file", async () => {
    const file = new File(["hello"], "hello.txt", {
      type: "text/plain",
      lastModified: 1700000000000,
    });

    const firstManifest = await createFileManifest(file, "transfer-1");
    const secondManifest = await createFileManifest(file, "transfer-1");

    expect(firstManifest).toEqual(secondManifest);
    expect(firstManifest).toMatchObject({
      transferId: "transfer-1",
      name: "hello.txt",
      size: 5,
      type: "text/plain",
      lastModified: 1700000000000,
      chunkCount: 1,
    });
    expect(firstManifest.fileId).toMatch(/^file-/);
    expect(firstManifest.fileHash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("rounds large file chunk count upward", async () => {
    const file = {
      name: "large.bin",
      size: GiB + 1,
      slice: () => new Blob(["large chunk"]),
      type: "",
      lastModified: 1700000000000,
    } as unknown as File;
    const manifest = await createFileManifest(file, "transfer-2");

    expect(manifest.chunkSize).toBe(LARGE_FILE_CHUNK_BYTES);
    expect(manifest.chunkCount).toBe(Math.ceil((GiB + 1) / LARGE_FILE_CHUNK_BYTES));
  });

  it("uses selection index to distinguish duplicate file metadata", async () => {
    const options = {
      type: "application/octet-stream",
      lastModified: 1700000000000,
    };
    const firstFile = new File(["same"], "duplicate.bin", options);
    const secondFile = new File(["same"], "duplicate.bin", options);

    const firstManifest = await createFileManifest(firstFile, "transfer-duplicates", 0);
    const secondManifest = await createFileManifest(secondFile, "transfer-duplicates", 1);

    expect(firstManifest.fileId).not.toBe(secondManifest.fileId);
  });

  it("uses one chunk for zero-byte files", async () => {
    const file = new File([], "empty.txt", {
      type: "text/plain",
      lastModified: 1700000000000,
    });

    const manifest = await createFileManifest(file, "transfer-empty");

    expect(manifest.size).toBe(0);
    expect(manifest.chunkCount).toBe(1);
  });
});
