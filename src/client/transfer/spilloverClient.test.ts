import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EncryptedChunkTransferMessage } from "./dataChannelTransfer";
import {
  deleteSpilloverChunk,
  downloadSpilloverChunk,
  uploadSpilloverChunk,
} from "./spilloverClient";

describe("spillover client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads encrypted chunk ciphertext with room recovery credentials", async () => {
    const fetchMock = vi.mocked(fetch);
    const message = createEncryptedChunkMessage(new Uint8Array([1, 2, 3]));
    fetchMock.mockResolvedValueOnce(
      Response.json({
        transferId: "transfer-1",
        fileId: "file-1",
        chunkIndex: 2,
        ivBase64: "chunk-iv",
        ciphertextBytes: 3,
        expiresAt: 1_700_000_000_000,
      }),
    );

    const ref = await uploadSpilloverChunk(
      { roomId: "room-ABC123", recoveryToken: "recovery-1" },
      message,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(url).toBe("/api/rooms/room-ABC123/spillover/transfer-1/file-1/2");
    expect(init?.method).toBe("PUT");
    expect(headers.get("x-recovery-token")).toBe("recovery-1");
    expect(headers.get("x-spillover-iv")).toBe("chunk-iv");
    expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(ref).toMatchObject({ ciphertextBytes: 3, chunkIndex: 2 });
  });

  it("downloads encrypted chunk ciphertext back into a transfer message", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([7, 8, 9]), {
        headers: {
          "content-type": "application/octet-stream",
          "x-spillover-iv": "download-iv",
        },
      }),
    );

    const message = await downloadSpilloverChunk(
      { roomId: "room-ABC123", recoveryToken: "recovery-1" },
      {
        transferId: "transfer-1",
        fileId: "file-1",
        chunkIndex: 2,
        ivBase64: "chunk-iv",
        ciphertextBytes: 3,
      },
    );

    expect(fetchMock).toHaveBeenCalledWith("/api/rooms/room-ABC123/spillover/transfer-1/file-1/2", {
      headers: { "x-recovery-token": "recovery-1" },
    });
    expect(message).toEqual({
      type: "chunk",
      transferId: "transfer-1",
      fileId: "file-1",
      chunkIndex: 2,
      ivBase64: "download-iv",
      ciphertextBase64: "BwgJ",
    });
  });

  it("deletes spillover chunks after they are acknowledged", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await deleteSpilloverChunk(
      { roomId: "room-ABC123", recoveryToken: "recovery-1" },
      {
        transferId: "transfer-1",
        fileId: "file-1",
        chunkIndex: 2,
        ivBase64: "chunk-iv",
        ciphertextBytes: 3,
      },
    );

    expect(fetchMock).toHaveBeenCalledWith("/api/rooms/room-ABC123/spillover/transfer-1/file-1/2", {
      method: "DELETE",
      headers: { "x-recovery-token": "recovery-1" },
    });
  });
});

function createEncryptedChunkMessage(ciphertext: Uint8Array): EncryptedChunkTransferMessage {
  return {
    type: "chunk",
    transferId: "transfer-1",
    fileId: "file-1",
    chunkIndex: 2,
    ivBase64: "chunk-iv",
    ciphertextBase64: bytesToBase64(ciphertext),
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return btoa(binary);
}
