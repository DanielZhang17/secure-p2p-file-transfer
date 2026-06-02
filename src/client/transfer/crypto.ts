export interface PeerKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

export interface TransferKeys {
  contentKey: CryptoKey;
  verificationKey: ArrayBuffer;
}

export interface EncryptedChunk {
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>;
}

const textEncoder = new TextEncoder();
const maxUint32 = 0xffffffff;
const phraseWords = [
  "amber",
  "brook",
  "cobalt",
  "delta",
  "ember",
  "forest",
  "granite",
  "harbor",
  "indigo",
  "juniper",
  "kelp",
  "lantern",
  "mesa",
  "north",
  "opal",
  "prairie",
] as const;

export async function createPeerKeyPair(): Promise<PeerKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]) as Promise<PeerKeyPair>;
}

export async function deriveSharedTransferKeys(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  transferId: string,
): Promise<TransferKeys> {
  const sharedBits = await crypto.subtle.deriveBits({ name: "ECDH", public: peerPublicKey }, privateKey, 256);
  const baseKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey", "deriveBits"]);
  const salt = textEncoder.encode(`secure-p2p-transfer:${transferId}`);

  const contentKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: textEncoder.encode("chunk-content-key") },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const verificationKey = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: textEncoder.encode("verification-phrase") },
    baseKey,
    128,
  );

  return { contentKey, verificationKey };
}

export async function verificationPhrase(verificationKey: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", verificationKey));
  const words: string[] = [];

  for (let index = 0; index < 5; index += 1) {
    words.push(phraseWords[digest[index] >> 4]);
    words.push(phraseWords[digest[index] & 0x0f]);
  }

  return words.join("-");
}

export async function encryptChunk(
  contentKey: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
  fileId: string,
  chunkIndex: number,
): Promise<EncryptedChunk> {
  const iv = await chunkIv(fileId, chunkIndex);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, contentKey, plaintext));

  return { iv, ciphertext };
}

export async function decryptChunk(
  contentKey: CryptoKey,
  encrypted: EncryptedChunk,
  fileId: string,
  chunkIndex: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const expectedIv = await chunkIv(fileId, chunkIndex);

  if (!equalBytes(expectedIv, encrypted.iv)) {
    throw new Error("chunk IV mismatch");
  }

  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: expectedIv }, contentKey, encrypted.ciphertext));
}

async function chunkIv(fileId: string, chunkIndex: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > maxUint32) {
    throw new Error("chunk index out of range");
  }

  const fileDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(fileId)));
  const iv = fileDigest.slice(0, 12);
  new DataView(iv.buffer).setUint32(8, chunkIndex, false);

  return iv;
}

function equalBytes(left: Uint8Array<ArrayBuffer>, right: Uint8Array<ArrayBuffer>): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }

  return diff === 0;
}
