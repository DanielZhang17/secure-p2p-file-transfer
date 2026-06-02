export function assertRelayRequestAllowed(contentLength: number, maxBytes: number): void {
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    throw new Error("content length is required");
  }

  if (contentLength > maxBytes) {
    throw new Error("relay request exceeds configured limit");
  }
}
