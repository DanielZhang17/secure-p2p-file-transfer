const DECIMAL_INTEGER_PATTERN = /^[0-9]+$/;

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

export function parseRelayContentLength(value: string | null): number {
  return parseStrictDecimalInteger(value, "content length is required");
}

export function parseRelayMaxBytes(value: string | null): number {
  return parseStrictDecimalInteger(value, "relay limit is not configured");
}

function parseStrictDecimalInteger(value: string | null, errorMessage: string): number {
  if (value === null || !DECIMAL_INTEGER_PATTERN.test(value)) {
    throw new Error(errorMessage);
  }

  return Number(value);
}
