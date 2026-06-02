export function assertRelayRequestAllowed(contentLength: number, maxBytes: number): void {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || !Number.isInteger(maxBytes)) {
    throw new Error("relay limit is not configured");
  }

  if (!Number.isFinite(contentLength) || contentLength < 0) {
    throw new Error("content length is required");
  }

  if (contentLength > maxBytes) {
    throw new Error("relay request exceeds configured limit");
  }
}
