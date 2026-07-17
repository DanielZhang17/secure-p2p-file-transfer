import type { FileManifest } from "../../shared/protocol";
import { selectChunkProfile } from "./chunkProfile";
import { hashFile } from "./fileHash";

export async function createFileManifest(file: File, transferId: string, selectionIndex = 0): Promise<FileManifest> {
  const profile = selectChunkProfile(file.size);
  const stableInput = `${transferId}:${selectionIndex}:${file.name}:${file.size}:${file.lastModified}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableInput));
  const fileId = `file-${toHex(new Uint8Array(digest)).slice(0, 16)}`;
  const fileHash = await hashFile(file, profile.chunkSize);

  return {
    transferId,
    fileId,
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified,
    chunkSize: profile.chunkSize,
    chunkCount: Math.max(1, Math.ceil(file.size / profile.chunkSize)),
    fileHash,
  };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
