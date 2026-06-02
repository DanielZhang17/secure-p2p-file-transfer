import type { TransferRoom } from "./room";

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<TransferRoom>;
  SPILLOVER?: R2Bucket;
  ROOM_TTL_SECONDS: string;
  SPILLOVER_CAP_BYTES: string;
  MAX_RELAY_REQUEST_BYTES: string;
}

export function roomTtlMs(env: Env): number {
  return Number.parseInt(env.ROOM_TTL_SECONDS, 10) * 1000;
}
