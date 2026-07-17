import { describe, expect, it } from "vitest";
import { hashFile, verifyFileHash } from "./fileHash";

describe("fileHash", () => {
  it("hashes files incrementally from slices", async () => {
    const file = new File(["abc"], "abc.txt");

    await expect(hashFile(file, 1)).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("rejects completed files that do not match the manifest hash", async () => {
    const file = new File(["abc"], "abc.txt");

    await expect(
      verifyFileHash(file, {
        transferId: "transfer-1",
        fileId: "file-1",
        name: "abc.txt",
        size: file.size,
        type: "text/plain",
        lastModified: 1_700_000_000_000,
        chunkSize: 1,
        chunkCount: 3,
        fileHash: "wrong",
      }),
    ).rejects.toThrow("file hash mismatch");
  });
});
