import { describe, expect, it } from "vitest";
import { createPeerKeyPair, decryptChunk, deriveSharedTransferKeys, encryptChunk, verificationPhrase } from "./crypto";

describe("transfer crypto", () => {
  it("creates a non-extractable private key and exportable public key", async () => {
    const keys = await createPeerKeyPair();

    expect(keys.privateKey.extractable).toBe(false);
    expect(keys.publicKey.extractable).toBe(true);
  });

  it("derives matching verification phrases for both peers", async () => {
    const sender = await createPeerKeyPair();
    const recipient = await createPeerKeyPair();

    const senderKeys = await deriveSharedTransferKeys(sender.privateKey, recipient.publicKey, "transfer-1");
    const recipientKeys = await deriveSharedTransferKeys(recipient.privateKey, sender.publicKey, "transfer-1");

    const senderPhrase = await verificationPhrase(senderKeys.verificationKey);
    const recipientPhrase = await verificationPhrase(recipientKeys.verificationKey);

    expect(senderPhrase).toBe(recipientPhrase);
    expect(senderPhrase.replaceAll("-", "")).toMatch(/^[A-Z2-9]{26}$/);
  });

  it("derives different verification phrases for different transfer ids", async () => {
    const sender = await createPeerKeyPair();
    const recipient = await createPeerKeyPair();

    const firstKeys = await deriveSharedTransferKeys(sender.privateKey, recipient.publicKey, "transfer-1");
    const secondKeys = await deriveSharedTransferKeys(sender.privateKey, recipient.publicKey, "transfer-2");

    expect(await verificationPhrase(firstKeys.verificationKey)).not.toBe(await verificationPhrase(secondKeys.verificationKey));
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

  it("uses different IVs and ciphertexts for different chunk indexes", async () => {
    const sender = await createPeerKeyPair();
    const recipient = await createPeerKeyPair();
    const senderKeys = await deriveSharedTransferKeys(sender.privateKey, recipient.publicKey, "transfer-3");
    const recipientKeys = await deriveSharedTransferKeys(recipient.privateKey, sender.publicKey, "transfer-3");
    const plaintext = new TextEncoder().encode("chunk payload");

    const firstChunk = await encryptChunk(senderKeys.contentKey, plaintext, "file-1", 7);
    const secondChunk = await encryptChunk(senderKeys.contentKey, plaintext, "file-1", 8);

    expect(firstChunk.iv).not.toEqual(secondChunk.iv);
    expect(firstChunk.ciphertext).not.toEqual(secondChunk.ciphertext);
    await expect(decryptChunk(recipientKeys.contentKey, firstChunk, "file-1", 8)).rejects.toThrow("chunk IV mismatch");
  });

  it("uses different IVs for repeated chunk indexes in different files", async () => {
    const sender = await createPeerKeyPair();
    const recipient = await createPeerKeyPair();
    const senderKeys = await deriveSharedTransferKeys(sender.privateKey, recipient.publicKey, "transfer-4");

    const firstFileChunk = await encryptChunk(senderKeys.contentKey, new Uint8Array([1]), "file-1", 0);
    const secondFileChunk = await encryptChunk(senderKeys.contentKey, new Uint8Array([1]), "file-2", 0);

    expect(firstFileChunk.iv).not.toEqual(secondFileChunk.iv);
  });

  it("rejects decrypting with the wrong file id", async () => {
    const sender = await createPeerKeyPair();
    const recipient = await createPeerKeyPair();
    const senderKeys = await deriveSharedTransferKeys(sender.privateKey, recipient.publicKey, "transfer-5");
    const recipientKeys = await deriveSharedTransferKeys(recipient.privateKey, sender.publicKey, "transfer-5");

    const encrypted = await encryptChunk(senderKeys.contentKey, new TextEncoder().encode("chunk payload"), "file-1", 7);

    await expect(decryptChunk(recipientKeys.contentKey, encrypted, "file-2", 7)).rejects.toThrow("chunk IV mismatch");
  });
});
