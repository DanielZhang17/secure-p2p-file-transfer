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
  });

  it("rounds large file chunk count upward", async () => {
    const file = {
      name: "large.bin",
      size: GiB + 1,
      type: "",
      lastModified: 1700000000000,
    } as unknown as File;
    const manifest = await createFileManifest(file, "transfer-2");

    expect(manifest.chunkSize).toBe(LARGE_FILE_CHUNK_BYTES);
    expect(manifest.chunkCount).toBe(Math.ceil((GiB + 1) / LARGE_FILE_CHUNK_BYTES));
  });
});
