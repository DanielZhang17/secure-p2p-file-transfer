import { describe, expect, it } from "vitest";
import type { FileManifest } from "../../shared/protocol";
import {
  acceptTransferMessage,
  createChunkAck,
  createEncryptedChunkFrameMessages,
  createIncomingTransferState,
  createTransferKeyExchangeMessage,
  createTransferMessages,
  getTransferContentKey,
  getTransferVerificationPhrase,
  parseDataChannelTransferMessage,
} from "./dataChannelTransfer";
import { loadReceivedFile } from "./receivedChunkStore";

describe("data channel transfer messages", () => {
  it("packs a small file into manifest and chunk messages that can be reassembled", async () => {
    const file = new File(["hello from sender"], "hello.txt", { type: "text/plain", lastModified: 1_700_000_000_000 });
    const manifest: FileManifest = {
      transferId: "transfer-1",
      fileId: "file-1",
      name: "hello.txt",
      size: file.size,
      type: "text/plain",
      lastModified: file.lastModified,
      chunkSize: 8,
      chunkCount: 3,
      fileHash: "6994ec86f5ff7ba5654e4264fda103c49daa5b6a08b502900d573ca09e451f3d",
    };

    const sender = createIncomingTransferState();
    const incoming = createIncomingTransferState();
    await exchangeKeys(sender, incoming, manifest.transferId);
    const contentKey = getTransferContentKey(sender, manifest.transferId);
    if (!contentKey) {
      throw new Error("expected sender content key");
    }
    const messages = await createTransferMessages(file, manifest, contentKey);
    let receivedFile: File | undefined;

    for (const message of messages) {
      receivedFile = (await acceptTransferMessage(incoming, message)) ?? receivedFile;
    }

    expect(messages.map((message) => message.type)).toEqual(["manifest", "chunk", "chunk", "chunk"]);
    expect(JSON.stringify(messages)).not.toContain("hello from sender");
    expect(receivedFile?.name).toBe("hello.txt");
    expect(receivedFile?.type).toBe("text/plain");
    expect(await receivedFile?.text()).toBe("hello from sender");
  });

  it("creates a deterministic ack for an encrypted chunk", async () => {
    const file = new File(["hello"], "hello.txt", { type: "text/plain", lastModified: 1_700_000_000_000 });
    const manifest: FileManifest = {
      transferId: "transfer-1",
      fileId: "file-1",
      name: "hello.txt",
      size: file.size,
      type: "text/plain",
      lastModified: file.lastModified,
      chunkSize: 8,
      chunkCount: 1,
    };
    const sender = createIncomingTransferState();
    const recipient = createIncomingTransferState();
    await exchangeKeys(sender, recipient, manifest.transferId);
    const contentKey = getTransferContentKey(sender, manifest.transferId);
    if (!contentKey) {
      throw new Error("expected sender content key");
    }
    const chunk = (await createTransferMessages(file, manifest, contentKey)).find((message) => message.type === "chunk");

    if (!chunk || chunk.type !== "chunk") {
      throw new Error("expected chunk message");
    }

    await expect(createChunkAck(chunk)).resolves.toMatchObject({
      transferId: "transfer-1",
      fileId: "file-1",
      chunkIndex: 0,
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(createChunkAck(chunk)).resolves.toEqual(await createChunkAck(chunk));
  });

  it("reassembles encrypted chunk frames before decrypting and completing a chunk", async () => {
    const file = new File(["framed payload"], "framed.txt", { type: "text/plain", lastModified: 1_700_000_000_000 });
    const manifest: FileManifest = {
      transferId: "transfer-frames",
      fileId: "file-frames",
      name: "framed.txt",
      size: file.size,
      type: "text/plain",
      lastModified: file.lastModified,
      chunkSize: 64,
      chunkCount: 1,
      fileHash: "b4d9d0911340944091c31658243331f9850afc191f24879949dd7846e44a0fd4",
    };
    const sender = createIncomingTransferState();
    const incoming = createIncomingTransferState();
    await exchangeKeys(sender, incoming, manifest.transferId);
    const contentKey = getTransferContentKey(sender, manifest.transferId);
    if (!contentKey) {
      throw new Error("expected sender content key");
    }
    const chunk = (await createTransferMessages(file, manifest, contentKey)).find((message) => message.type === "chunk");
    if (!chunk || chunk.type !== "chunk") {
      throw new Error("expected chunk");
    }
    const frames = createEncryptedChunkFrameMessages(chunk, 4);

    await acceptTransferMessage(incoming, { type: "manifest", manifest });
    let receivedFile: File | undefined;
    for (const frame of frames) {
      receivedFile = (await acceptTransferMessage(incoming, frame)) ?? receivedFile;
    }

    expect(frames.length).toBeGreaterThan(1);
    expect(await receivedFile?.text()).toBe("framed payload");
  });

  it("streams decrypted chunks to a receiver-provided writer without reconstructing the file", async () => {
    const file = new File(["stream me"], "stream.txt", { type: "text/plain", lastModified: 1_700_000_000_000 });
    const manifest: FileManifest = {
      transferId: "transfer-stream",
      fileId: "file-stream",
      name: "stream.txt",
      size: file.size,
      type: "text/plain",
      lastModified: file.lastModified,
      chunkSize: 64,
      chunkCount: 1,
      fileHash: "072e61241ebf17f37fd33dbe578b6819619f17cd56144512a070999cfb4bdd40",
    };
    const writes: Array<{ chunkIndex: number; text: string }> = [];
    const completed: string[] = [];
    const sender = createIncomingTransferState();
    const incoming = createIncomingTransferState({
      completeReceivedFile: async (completedManifest) => {
        completed.push(completedManifest.fileId);
      },
      writeReceivedChunk: async ({ bytes: chunkBytes, chunkIndex }) => {
        writes.push({ chunkIndex, text: new TextDecoder().decode(chunkBytes) });
        return true;
      },
    });
    await exchangeKeys(sender, incoming, manifest.transferId);
    const contentKey = getTransferContentKey(sender, manifest.transferId);
    if (!contentKey) {
      throw new Error("expected sender content key");
    }
    const messages = await createTransferMessages(file, manifest, contentKey);

    for (const message of messages) {
      await acceptTransferMessage(incoming, message);
    }

    await expect(loadReceivedFile(manifest)).resolves.toBeUndefined();
    expect(writes).toEqual([{ chunkIndex: 0, text: "stream me" }]);
    expect(completed).toEqual(["file-stream"]);
  });

  it("stores decrypted chunks when persistent receiver state is enabled", async () => {
    const file = new File(["persist me"], "persist.txt", { type: "text/plain", lastModified: 1_700_000_000_000 });
    const manifest: FileManifest = {
      transferId: "transfer-persist",
      fileId: "file-persist",
      name: "persist.txt",
      size: file.size,
      type: "text/plain",
      lastModified: file.lastModified,
      chunkSize: 64,
      chunkCount: 1,
      fileHash: "6863acf020141ec08d69ee951d6ec9fdd5e01eaf80d728b7e317b31f73092392",
    };
    const sender = createIncomingTransferState();
    const incoming = createIncomingTransferState({ persistReceivedChunks: true });
    await exchangeKeys(sender, incoming, manifest.transferId);
    const contentKey = getTransferContentKey(sender, manifest.transferId);
    if (!contentKey) {
      throw new Error("expected sender content key");
    }
    const messages = await createTransferMessages(file, manifest, contentKey);

    for (const message of messages) {
      await acceptTransferMessage(incoming, message);
    }

    await expect(loadReceivedFile(manifest).then((storedFile) => storedFile?.text())).resolves.toBe("persist me");
  });

  it("rejects completed files whose plaintext hash does not match the manifest", async () => {
    const file = new File(["tampered"], "tamper.txt", { type: "text/plain", lastModified: 1_700_000_000_000 });
    const manifest: FileManifest = {
      transferId: "transfer-hash",
      fileId: "file-hash",
      name: "tamper.txt",
      size: file.size,
      type: "text/plain",
      lastModified: file.lastModified,
      chunkSize: 64,
      chunkCount: 1,
      fileHash: "wrong",
    };
    const sender = createIncomingTransferState();
    const incoming = createIncomingTransferState();
    await exchangeKeys(sender, incoming, manifest.transferId);
    const contentKey = getTransferContentKey(sender, manifest.transferId);
    if (!contentKey) {
      throw new Error("expected sender content key");
    }
    const messages = await createTransferMessages(file, manifest, contentKey);

    await acceptTransferMessage(incoming, messages[0]);
    await expect(acceptTransferMessage(incoming, messages[1])).rejects.toThrow("file hash mismatch");
  });

  it("derives the same verification phrase on both sides of a key exchange", async () => {
    const sender = createIncomingTransferState();
    const recipient = createIncomingTransferState();

    await exchangeKeys(sender, recipient, "transfer-verify");

    expect(getTransferVerificationPhrase(sender, "transfer-verify")).toBe(
      getTransferVerificationPhrase(recipient, "transfer-verify"),
    );
    expect(getTransferVerificationPhrase(sender, "transfer-verify")?.replaceAll("-", "")).toMatch(/^[A-Z2-9]{26}$/);
  });

  it("rejects replacing an established peer key for the same transfer", async () => {
    const receiver = createIncomingTransferState();
    const firstPeer = createIncomingTransferState();
    const secondPeer = createIncomingTransferState();
    const firstKey = await createTransferKeyExchangeMessage(firstPeer, "transfer-fixed-key");
    const replacementKey = await createTransferKeyExchangeMessage(secondPeer, "transfer-fixed-key");

    await acceptTransferMessage(receiver, firstKey);
    await expect(acceptTransferMessage(receiver, replacementKey)).rejects.toThrow("transfer peer key changed");
  });

  it("rejects manifests that would allocate an unbounded recovery bitmap", () => {
    const payload = JSON.stringify({
      type: "manifest",
      manifest: {
        transferId: "transfer-1",
        fileId: "file-1",
        name: "large.bin",
        size: 1,
        type: "application/octet-stream",
        lastModified: 1,
        chunkSize: 1,
        chunkCount: 1_000_001,
      },
    });

    expect(parseDataChannelTransferMessage(payload)).toBeNull();
  });

  it("rejects changing a manifest after a file id is established", async () => {
    const incoming = createIncomingTransferState();
    const manifest: FileManifest = {
      transferId: "transfer-fixed-manifest",
      fileId: "file-fixed-manifest",
      name: "original.bin",
      size: 1,
      type: "application/octet-stream",
      lastModified: 1,
      chunkSize: 1,
      chunkCount: 1,
    };

    await acceptTransferMessage(incoming, { type: "manifest", manifest });
    await expect(
      acceptTransferMessage(incoming, {
        type: "manifest",
        manifest: { ...manifest, name: "replacement.bin" },
      }),
    ).rejects.toThrow("transfer manifest changed");
  });

  it("bounds concurrently incomplete chunk frame accumulators", async () => {
    const incoming = createIncomingTransferState();
    const manifest: FileManifest = {
      transferId: "transfer-bounded-frames",
      fileId: "file-bounded-frames",
      name: "frames.bin",
      size: 33,
      type: "application/octet-stream",
      lastModified: 1,
      chunkSize: 1,
      chunkCount: 33,
    };
    await acceptTransferMessage(incoming, { type: "manifest", manifest });

    for (let chunkIndex = 0; chunkIndex < 32; chunkIndex += 1) {
      await acceptTransferMessage(incoming, {
        type: "chunk-frame",
        transferId: manifest.transferId,
        fileId: manifest.fileId,
        chunkIndex,
        frameIndex: 0,
        finalFrame: false,
        ivBase64: "AAAAAAAAAAAAAAAA",
        ciphertextBase64: "AA==",
      });
    }

    await expect(
      acceptTransferMessage(incoming, {
        type: "chunk-frame",
        transferId: manifest.transferId,
        fileId: manifest.fileId,
        chunkIndex: 32,
        frameIndex: 0,
        finalFrame: false,
        ivBase64: "AAAAAAAAAAAAAAAA",
        ciphertextBase64: "AA==",
      }),
    ).rejects.toThrow("too many active chunk frame accumulators");
  });
});

async function exchangeKeys(
  left: ReturnType<typeof createIncomingTransferState>,
  right: ReturnType<typeof createIncomingTransferState>,
  transferId: string,
): Promise<void> {
  const leftMessage = await createTransferKeyExchangeMessage(left, transferId);
  const rightMessage = await createTransferKeyExchangeMessage(right, transferId);
  await acceptTransferMessage(left, rightMessage);
  await acceptTransferMessage(right, leftMessage);
}
