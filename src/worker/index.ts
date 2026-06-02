import type { Env } from "./env";

export { TransferRoom } from "./room";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/api/rooms" && request.method === "POST") {
        const roomId = `room-${crypto.randomUUID()}`;
        const id = env.ROOMS.idFromName(roomId);
        const stub = env.ROOMS.get(id);

        return stub.fetch(
          new Request("https://room/init", {
            method: "POST",
            body: JSON.stringify({ roomId }),
            headers: { "content-type": "application/json" },
          }),
        );
      }

      const roomMatch = /^\/api\/rooms\/([^/]+)$/.exec(url.pathname);
      if (roomMatch) {
        const roomId = decodeURIComponent(roomMatch[1]);
        const id = env.ROOMS.idFromName(roomId);
        const stub = env.ROOMS.get(id);

        return stub.fetch(request);
      }

      if (url.pathname.startsWith("/api/")) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      ctx.waitUntil(logUnexpectedError(error, request));
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

function logUnexpectedError(error: unknown, request: Request): Promise<void> {
  const url = new URL(request.url);
  const message = error instanceof Error ? error.message : String(error);

  return Promise.resolve().then(() => {
    console.error(
      JSON.stringify({
        level: "error",
        event: "worker.unexpected_error",
        path: url.pathname,
        message,
      }),
    );
  });
}
