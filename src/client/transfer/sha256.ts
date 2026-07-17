const initialHash: number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as number[];

const roundConstants = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

const blockBytes = 64;
const wordCount = 64;

export class Sha256 {
  private readonly block = new Uint8Array(blockBytes);
  private blockLength = 0;
  private readonly hash = initialHash.slice();
  private totalBytes = 0n;

  update(bytes: Uint8Array): this {
    let offset = 0;
    this.totalBytes += BigInt(bytes.byteLength);

    while (offset < bytes.byteLength) {
      const take = Math.min(blockBytes - this.blockLength, bytes.byteLength - offset);
      this.block.set(bytes.subarray(offset, offset + take), this.blockLength);
      this.blockLength += take;
      offset += take;

      if (this.blockLength === blockBytes) {
        this.compress(this.block);
        this.blockLength = 0;
      }
    }

    return this;
  }

  digestHex(): string {
    const bitLength = this.totalBytes * 8n;

    this.block[this.blockLength] = 0x80;
    this.blockLength += 1;

    if (this.blockLength > 56) {
      this.block.fill(0, this.blockLength);
      this.compress(this.block);
      this.blockLength = 0;
    }

    this.block.fill(0, this.blockLength, 56);
    const view = new DataView(this.block.buffer);
    view.setUint32(56, Number((bitLength >> 32n) & 0xffffffffn), false);
    view.setUint32(60, Number(bitLength & 0xffffffffn), false);
    this.compress(this.block);

    return this.hash.map((word) => word.toString(16).padStart(8, "0")).join("");
  }

  private compress(block: Uint8Array): void {
    const words = new Uint32Array(wordCount);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);

    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(index * 4, false);
    }

    for (let index = 16; index < wordCount; index += 1) {
      const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = add(words[index - 16], s0, words[index - 7], s1);
    }

    let [a, b, c, d, e, f, g, h] = this.hash;

    for (let index = 0; index < wordCount; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = add(h, s1, ch, roundConstants[index], words[index]);
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = add(s0, maj);

      h = g;
      g = f;
      f = e;
      e = add(d, temp1);
      d = c;
      c = b;
      b = a;
      a = add(temp1, temp2);
    }

    this.hash[0] = add(this.hash[0], a);
    this.hash[1] = add(this.hash[1], b);
    this.hash[2] = add(this.hash[2], c);
    this.hash[3] = add(this.hash[3], d);
    this.hash[4] = add(this.hash[4], e);
    this.hash[5] = add(this.hash[5], f);
    this.hash[6] = add(this.hash[6], g);
    this.hash[7] = add(this.hash[7], h);
  }
}

function rotateRight(word: number, bits: number): number {
  return (word >>> bits) | (word << (32 - bits));
}

function add(...values: number[]): number {
  return values.reduce((sum, value) => (sum + value) >>> 0, 0);
}
