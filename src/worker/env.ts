export type Env = Cloudflare.Env;

export function roomTtlMs(env: Env): number {
  return Number.parseInt(env.ROOM_TTL_SECONDS, 10) * 1000;
}
