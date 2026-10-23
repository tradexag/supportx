import { HttpError, requestJson } from "../http.ts";

/**
 * eBay OAuth 2.0, authorization code grant, for one seller account.
 *
 * Adapted from the project owner's ASEIO eBay connector (contributed under MIT),
 * including two lessons learned there:
 * - `prompt=login` forces the eBay sign-in even with an existing eBay session,
 *   so the consent cannot silently pick whichever account was logged in last.
 * - A refresh must request exactly the scopes the seller granted, never more.
 *
 * Every operator registers their own eBay developer keyset (client id, secret,
 * RuName). The RuName's "auth accepted URL" points to
 * `${PUBLIC_BASE_URL}/oauth/ebay/callback`.
 */
const SCOPE = "https://api.ebay.com/oauth/api_scope";
export const EBAY_MESSAGE_SCOPES: ReadonlyArray<string> = [`${SCOPE}/commerce.message`, `${SCOPE}/commerce.identity.readonly`];

export interface EbayApp {
  clientId: string;
  clientSecret: string;
  ruName: string;
  sandbox?: boolean;
  /** Test doubles only (ALLOW_TEST_ENDPOINTS); live hosts are fixed. */
  authBaseUrl?: string;
  apiBaseUrl?: string;
  identityBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function ebayHosts(app: Pick<EbayApp, "sandbox" | "authBaseUrl" | "apiBaseUrl" | "identityBaseUrl">): { auth: string; api: string; identity: string } {
  const sb = app.sandbox ? ".sandbox" : "";
  return {
    auth: app.authBaseUrl ?? `https://auth${sb}.ebay.com`,
    api: app.apiBaseUrl ?? `https://api${sb}.ebay.com`,
    // The Identity API lives on apiz, not api.
    identity: app.identityBaseUrl ?? `https://apiz${sb}.ebay.com`,
  };
}

export function isOfficialEbayHost(url: URL): boolean {
  return /^(auth|api|apiz)(\.sandbox)?\.ebay\.com$/.test(url.hostname);
}

export function buildEbayAuthorizeUrl(app: EbayApp, state: string): string {
  const url = new URL(`${ebayHosts(app).auth}/oauth2/authorize`);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", app.ruName);
  url.searchParams.set("scope", EBAY_MESSAGE_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "login");
  return url.toString();
}

export interface EbayTokens {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
  scopes: string[];
}

async function tokenRequest(app: EbayApp, form: URLSearchParams): Promise<EbayTokens> {
  const raw = (await requestJson(`${ebayHosts(app).api}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    timeoutMs: 15_000,
    fetchImpl: app.fetchImpl,
  })) as { access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number } | null;
  if (!raw?.access_token) throw new HttpError("eBay lieferte keinen Access-Token.", 0, false);
  return {
    accessToken: raw.access_token,
    expiresAt: Date.now() + (raw.expires_in ?? 7200) * 1000,
    refreshToken: raw.refresh_token,
    refreshTokenExpiresAt: raw.refresh_token_expires_in ? new Date(Date.now() + raw.refresh_token_expires_in * 1000).toISOString() : undefined,
    scopes: [...EBAY_MESSAGE_SCOPES],
  };
}

export function exchangeEbayCode(app: EbayApp, code: string): Promise<EbayTokens> {
  return tokenRequest(app, new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: app.ruName }));
}

export function refreshEbayToken(app: EbayApp, refreshToken: string, grantedScopes: ReadonlyArray<string>): Promise<EbayTokens> {
  return tokenRequest(app, new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, scope: grantedScopes.join(" ") }));
}

/** The seller's eBay username; used to tell our own messages from buyer messages. */
export async function fetchEbayUsername(app: EbayApp, accessToken: string): Promise<string> {
  const raw = (await requestJson(`${ebayHosts(app).identity}/commerce/identity/v1/user/`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    timeoutMs: 15_000,
    fetchImpl: app.fetchImpl,
  })) as { username?: string } | null;
  const username = typeof raw?.username === "string" ? raw.username.trim() : "";
  if (!username) throw new HttpError("eBay lieferte keinen Benutzernamen für das Verkäuferkonto.", 0, false);
  return username;
}
