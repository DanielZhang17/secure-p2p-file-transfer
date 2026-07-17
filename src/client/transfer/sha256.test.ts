import { describe, expect, it } from "vitest";
import { Sha256 } from "./sha256";

const encoder = new TextEncoder();

describe("Sha256", () => {
  it("matches SHA-256 test vectors", () => {
    expect(new Sha256().digestHex()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(new Sha256().update(encoder.encode("abc")).digestHex()).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches one-shot hashing when updated incrementally", () => {
    const oneShot = new Sha256().update(encoder.encode("hello world")).digestHex();
    const incremental = new Sha256()
      .update(encoder.encode("hello "))
      .update(encoder.encode("world"))
      .digestHex();

    expect(incremental).toBe(oneShot);
  });
});
