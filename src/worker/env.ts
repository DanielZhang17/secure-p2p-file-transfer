import type { TurnCredentialsEnv } from "./turn";
import type { StatsEnv } from "./stats";

export type Env = Cloudflare.Env & TurnCredentialsEnv & StatsEnv;

export function roomTtlMs(env: Env): number {
  return Number.parseInt(env.ROOM_TTL_SECONDS, 10) * 1000;
}
