import { createHmac } from "node:crypto";

/**
 * HMAC-SHA256 request signature of the Kaufland Seller API v2
 * (https://sellerapi.kaufland.com/?page=rest-api).
 *
 * Signature base, joined by "\n" without a trailing newline:
 *   HTTP method (upper case), full URL incl. query string, raw request body
 *   (empty for GET), Unix timestamp in seconds. Digest: lower-case hex.
 *
 * Adapted from the project owner's ASEIO Kaufland connector (contributed under MIT).
 */
export function kauflandSignatureBase(input: { method: string; url: string; body: string; timestamp: number }): string {
  return [input.method.toUpperCase(), input.url, input.body, String(input.timestamp)].join("\n");
}

export function signKauflandRequest(input: { method: string; url: string; body: string; timestamp: number; secretKey: string }): string {
  return createHmac("sha256", input.secretKey).update(kauflandSignatureBase(input), "utf8").digest("hex");
}

export function kauflandHeaders(input: { clientKey: string; secretKey: string; method: string; url: string; body: string; timestamp?: number }): Record<string, string> {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  return {
    Accept: "application/json",
    "Shop-Client-Key": input.clientKey,
    "Shop-Timestamp": String(timestamp),
    "Shop-Signature": signKauflandRequest({ ...input, timestamp }),
    "User-Agent": "SupportX/0.2",
  };
}
