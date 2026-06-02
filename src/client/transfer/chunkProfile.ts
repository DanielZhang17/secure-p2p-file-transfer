import {
  DEFAULT_RELAY_SUBFRAME_BYTES,
  LARGE_FILE_CHUNK_BYTES,
  LARGE_FILE_LANES,
  SMALL_FILE_CHUNK_BYTES,
  SMALL_FILE_LANES,
  SMALL_FILE_THRESHOLD_BYTES,
} from "../../shared/limits";

export interface ChunkProfile {
  chunkSize: number;
  lanes: number;
  subframeSize: number;
}

export function selectChunkProfile(fileSize: number): ChunkProfile {
  if (!Number.isFinite(fileSize) || fileSize < 0) {
    throw new Error("fileSize must be a non-negative finite number");
  }

  if (fileSize <= SMALL_FILE_THRESHOLD_BYTES) {
    return {
      chunkSize: SMALL_FILE_CHUNK_BYTES,
      lanes: SMALL_FILE_LANES,
      subframeSize: DEFAULT_RELAY_SUBFRAME_BYTES,
    };
  }

  return {
    chunkSize: LARGE_FILE_CHUNK_BYTES,
    lanes: LARGE_FILE_LANES,
    subframeSize: DEFAULT_RELAY_SUBFRAME_BYTES,
  };
}
