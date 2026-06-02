import { describe, expect, it } from "vitest";
import { createPeerKeyPair, decryptChunk, deriveSharedTransferKeys, encryptChunk, verificationPhrase } from "./crypto";

describe("transfer crypto", () => {
  it("derives matching verification phrases for both peers", async () => {
    const sender = await createPeerKeyPair();
    const recipient = await createPeerKeyPair();

    const senderKeys = await deriveSharedTransferKeys(sender.privateKey, recipient.publicKey, "transfer-1");
    const recipientKeys = await deriveSharedTransferKeys(recipient.privateKey, sender.publicKey, "transfer-1");

    expect(await verificationPhrase(senderKeys.verificationKey)).toBe(await verificationPhrase(recipientKeys.verificationKey));
  });

  it("encrypts and decrypts a chunk", async () => {
    const sender = await createPeerKeyPair();
    const recipient = await createPeerKeyPair();
    const senderKeys = await deriveSharedTransferKeys(sender.privateKey, recipient.publicKey, "transfer-2");
    const recipientKeys = await deriveSharedTransferKeys(recipient.privateKey, sender.publicKey, "transfer-2");
    const plaintext = new TextEncoder().encode("chunk payload");

    const encrypted = await encryptChunk(senderKeys.contentKey, plaintext, "file-1", 7);
    const decrypted = await decryptChunk(recipientKeys.contentKey, encrypted, "file-1", 7);

    expect(new TextDecoder().decode(decrypted)).toBe("chunk payload");
  });

  it("rejects decrypting with the wrong file id or chunk index", async () => {
    const sender = await createPeerKeyPair();
    const recipient = await createPeerKeyPair();
    const senderKeys = await deriveSharedTransferKeys(sender.privateKey, recipient.publicKey, "transfer-3");
    const recipientKeys = await deriveSharedTransferKeys(recipient.privateKey, sender.publicKey, "transfer-3");

    const encrypted = await encryptChunk(senderKeys.contentKey, new TextEncoder().encode("chunk payload"), "file-1", 7);

    await expect(decryptChunk(recipientKeys.contentKey, encrypted, "file-2", 7)).rejects.toThrow("chunk IV mismatch");
    await expect(decryptChunk(recipientKeys.contentKey, encrypted, "file-1", 8)).rejects.toThrow("chunk IV mismatch");
  });

  it("uses different IVs for repeated chunk indexes in different files", async () => {
    const keys = await deriveSharedTransferKeys(
      (await createPeerKeyPair()).privateKey,
      (await createPeerKeyPair()).publicKey,
      "transfer-4",
    );

    const firstFileChunk = await encryptChunk(keys.contentKey, new Uint8Array([1]), "file-1", 0);
    const secondFileChunk = await encryptChunk(keys.contentKey, new Uint8Array([1]), "file-2", 0);

    expect(firstFileChunk.iv).not.toEqual(secondFileChunk.iv);
  });
});
