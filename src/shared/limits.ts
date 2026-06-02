export const MiB = 1024 * 1024;
export const GiB = 1024 * MiB;

export const SMALL_FILE_THRESHOLD_BYTES = 1 * GiB;
export const LARGE_FILE_CHUNK_BYTES = 64 * MiB;
export const SMALL_FILE_CHUNK_BYTES = 8 * MiB;
export const LARGE_FILE_LANES = 8;
export const SMALL_FILE_LANES = 2;
export const DEFAULT_RELAY_SUBFRAME_BYTES = 4 * MiB;
export const MIN_RELAY_SUBFRAME_BYTES = 1 * MiB;
export const MAX_RELAY_SUBFRAME_BYTES = 8 * MiB;
export const MAX_RELAY_REQUEST_BYTES = 64 * MiB;
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
