interface Env {
  ASSETS: Fetcher;
}

function jsonNotFound() {
  return Response.json({ error: "not_found" }, { status: 404 });
}

export class TransferRoom {
  fetch() {
    return jsonNotFound();
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return jsonNotFound();
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
