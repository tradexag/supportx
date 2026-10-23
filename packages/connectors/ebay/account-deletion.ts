import { createHash, createPublicKey, verify } from "node:crypto";
import { HttpError, requestJson } from "../http.ts";
import { ebayHosts, type EbayApp } from "./oauth.ts";

/**
 * eBay Marketplace Account Deletion notifications. Every production keyset must
 * subscribe to them (or claim an exemption) before it can call the APIs.
 *
 * Documentation reviewed 2026-10-22 (docs/SOURCES.md, EBAY-5):
 * - Validation: GET <endpoint>?challenge_code=… answered with 200 and
 *   {"challengeResponse": sha256hex(challengeCode + verificationToken + endpoint)}.
 * - Token: 32–80 characters, letters, digits, "_" and "-".
 * - Notification: POST with header x-ebay-signature, acknowledged with 200/201/202/204,
 *   otherwise resent; a failed signature check is answered with 412.
 * - The header is base64 JSON {alg, kid, signature, digest}; the public key comes from
 *   the Notification API getPublicKey (application token) and is cached for an hour.
 *   The signature is ECDSA over the raw body with the given digest (as eBay's official
 *   event notification SDKs do it). Not yet verified with a real keyset.
 */
export const EBAY_DELETION_PATH = "/webhooks/ebay/account-deletion";
const TOKEN = /^[A-Za-z0-9_-]{32,80}$/;

export function isValidVerificationToken(token: string): boolean {
  return TOKEN.test(token);
}

export function ebayChallengeResponse(challengeCode: string, verificationToken: string, endpoint: string): string {
  return createHash("sha256").update(challengeCode).update(verificationToken).update(endpoint).digest("hex");
}

export interface EbaySignatureHeader {
  alg: string;
  kid: string;
  signature: string;
  digest: string;
}

export function parseEbaySignatureHeader(header: string | undefined): EbaySignatureHeader | null {
  if (!header || header.length > 4000) return null;
  try {
    const raw = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
    const { alg, kid, signature, digest } = raw;
    if (typeof kid !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(kid) || typeof signature !== "string" || !signature) return null;
    return { alg: typeof alg === "string" ? alg : "ecdsa", kid, signature, digest: typeof digest === "string" ? digest : "SHA1" };
  } catch {
    return null;
  }
}

export interface EbayPublicKey {
  algorithm: string;
  digest: string;
  key: string;
}

/** eBay returns the PEM sometimes without line breaks; Node needs them. */
function normalisePem(key: string): string {
  const body = key.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
  return `-----BEGIN PUBLIC KEY-----\n${body.match(/.{1,64}/g)?.join("\n") ?? ""}\n-----END PUBLIC KEY-----\n`;
}

export function verifyEbaySignature(rawBody: string, header: EbaySignatureHeader, publicKey: EbayPublicKey): boolean {
  if (!/^ecdsa$/i.test(publicKey.algorithm) || !/^ecdsa$/i.test(header.alg)) return false;
  const digest = (publicKey.digest || header.digest).toUpperCase();
  if (!["SHA1", "SHA256"].includes(digest)) return false;
  try {
    return verify(digest.toLowerCase(), Buffer.from(rawBody, "utf8"), createPublicKey(normalisePem(publicKey.key)), Buffer.from(header.signature, "base64"));
  } catch {
    return false;
  }
}

async function applicationToken(app: EbayApp): Promise<string> {
  const raw = (await requestJson(`${ebayHosts(app).api}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" }).toString(),
    timeoutMs: 15_000,
    fetchImpl: app.fetchImpl,
  })) as { access_token?: string } | null;
  if (!raw?.access_token) throw new HttpError("eBay lieferte keinen Anwendungs-Token.", 0, true);
  return raw.access_token;
}

export async function fetchEbayPublicKey(app: EbayApp, kid: string): Promise<EbayPublicKey> {
  const token = await applicationToken(app);
  const raw = (await requestJson(`${ebayHosts(app).api}/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    timeoutMs: 15_000,
    fetchImpl: app.fetchImpl,
  })) as Partial<EbayPublicKey> | null;
  if (!raw?.key || !raw.algorithm) throw new HttpError("eBay lieferte keinen öffentlichen Schlüssel.", 0, true);
  return { algorithm: raw.algorithm, digest: raw.digest ?? "SHA1", key: raw.key };
}

export interface EbayDeletionNotice {
  notificationId: string;
  username?: string;
  userId?: string;
}

export function parseEbayDeletionNotice(rawBody: string): EbayDeletionNotice | null {
  try {
    const body = JSON.parse(rawBody) as { metadata?: { topic?: string }; notification?: { notificationId?: unknown; data?: { username?: unknown; userId?: unknown } } };
    if (body.metadata?.topic !== "MARKETPLACE_ACCOUNT_DELETION") return null;
    const n = body.notification;
    if (!n || typeof n.notificationId !== "string") return null;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : undefined);
    return { notificationId: n.notificationId.slice(0, 200), username: str(n.data?.username), userId: str(n.data?.userId) };
  } catch {
    return null;
  }
}
