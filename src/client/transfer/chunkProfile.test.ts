import { describe, expect, it } from "vitest";
import { GiB, LARGE_FILE_CHUNK_BYTES, LARGE_FILE_LANES, SMALL_FILE_CHUNK_BYTES, SMALL_FILE_LANES } from "../../shared/limits";
import { selectChunkProfile } from "./chunkProfile";

describe("selectChunkProfile", () => {
  it("uses a light profile for files up to 1 GiB", () => {
    expect(selectChunkProfile(512 * 1024 * 1024)).toEqual({
      chunkSize: SMALL_FILE_CHUNK_BYTES,
      lanes: SMALL_FILE_LANES,
      subframeSize: 4 * 1024 * 1024,
    });
  });

  it("uses 64 MiB chunks and 8 lanes above 1 GiB", () => {
    expect(selectChunkProfile(2 * GiB)).toEqual({
      chunkSize: LARGE_FILE_CHUNK_BYTES,
      lanes: LARGE_FILE_LANES,
      subframeSize: 4 * 1024 * 1024,
    });
  });

  it("never selects a subframe larger than 8 MiB", () => {
    expect(selectChunkProfile(20 * GiB).subframeSize).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});
