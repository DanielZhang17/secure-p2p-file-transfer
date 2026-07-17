import type { FileManifest } from "../../shared/protocol";
import { Sha256 } from "./sha256";

const fallbackReadBytes = 1024 * 1024;

export async function hashFile(file: Blob, readSize = fallbackReadBytes): Promise<string> {
  if (!Number.isFinite(readSize) || readSize <= 0) {
    throw new Error("read size must be a positive number");
  }

  const digest = new Sha256();
  for (let offset = 0; offset < file.size; offset += readSize) {
    const bytes = new Uint8Array(await file.slice(offset, offset + readSize).arrayBuffer());
    digest.update(bytes);
  }

  return digest.digestHex();
}

export async function verifyFileHash(file: Blob, manifest: FileManifest): Promise<void> {
  if (!manifest.fileHash) {
    return;
  }

  const hash = await hashFile(file);
  if (hash !== manifest.fileHash) {
    throw new Error("file hash mismatch");
  }
}
