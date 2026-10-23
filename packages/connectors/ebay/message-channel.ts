import type { ConnectorCapabilities, IngressMessage, MessageChannel, ReconcileOutcome, ReplyOutcome, ReplyRequest, SyncResult } from "../../core/contracts.ts";
import { assertAllowedEndpoint, HttpError, requestJson } from "../http.ts";
import { cursorStart, isoOrNow, sameText, sendFailure, threadId } from "../marketplace-common.ts";
import { ebayHosts, isOfficialEbayHost, refreshEbayToken, type EbayApp } from "./oauth.ts";

/**
 * eBay Commerce Message API as a message channel.
 *
 * OpenAPI reviewed 2026-10-22 (docs/SOURCES.md, EBAY-1..EBAY-4), base
 * https://api.ebay.com/commerce/message/v1, scope commerce.message:
 * - GET /conversation?conversation_type=FROM_MEMBERS&start_time&limit&offset
 * - GET /conversation/{conversation_id}?conversation_type&limit&offset
 * - POST /send_message {conversationId, messageText} -> messageId
 * Only member conversations are read; FROM_EBAY notices stay in eBay.
 *
 * Not yet verified with a real account: whether start_time filters on creation
 * or last activity, page size limits, and how order references appear.
 * A listing reference (referenceId) is not an order id and is kept as metadata.
 */
export interface EbayMessageConfig extends EbayApp {
  refreshToken: string;
  grantedScopes: ReadonlyArray<string>;
  /** eBay username of the connected seller account (from the identity API at consent time). */
  sellerUsername: string;
  initialSyncDays?: number;
  maxConversationsPerSync?: number;
  timeoutMs?: number;
  allowTestEndpoints?: boolean;
}

type Json = Record<string, unknown>;
const PREFIX = "ebay:conversation:";
const TYPE = "FROM_MEMBERS";

export class EbayMessageChannel implements MessageChannel {
  readonly kind = "ebay_messages";
  readonly capabilities: ConnectorCapabilities = {
    receive: "configured",
    reply: "configured",
    attachments: "documented",
    pushNotifications: "documented",
    sendReconciliation: "configured",
  };
  readonly ownAddresses: ReadonlyArray<string>;
  readonly #config: EbayMessageConfig;
  readonly #base: string;
  #token: { value: string; expiresAt: number } | null = null;

  constructor(config: EbayMessageConfig) {
    if (!config.clientId || !config.clientSecret) throw new Error("eBay Client-ID und Client-Secret werden benötigt.");
    if (!config.refreshToken || !config.sellerUsername) throw new Error("Das eBay-Konto ist noch nicht verbunden (Anmeldung bei eBay fehlt).");
    const allow = config.allowTestEndpoints ?? false;
    const hosts = ebayHosts(config);
    for (const host of [hosts.api, hosts.auth, hosts.identity]) assertAllowedEndpoint(host, allow, isOfficialEbayHost);
    this.#config = config;
    this.#base = `${hosts.api.replace(/\/+$/, "")}/commerce/message/v1`;
    this.ownAddresses = [`ebay:${config.sellerUsername.toLowerCase()}`];
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt > Date.now() + 60_000) return this.#token.value;
    const tokens = await refreshEbayToken(this.#config, this.#config.refreshToken, this.#config.grantedScopes);
    this.#token = { value: tokens.accessToken, expiresAt: tokens.expiresAt };
    return tokens.accessToken;
  }

  async #call(method: "GET" | "POST", path: string, query: Record<string, string | number | undefined> = {}, body?: unknown): Promise<Json | null> {
    const url = new URL(`${this.#base}${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    return (await requestJson(url, {
      method,
      headers: { Authorization: `Bearer ${await this.#accessToken()}`, Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: this.#config.timeoutMs ?? 20_000,
      fetchImpl: this.#config.fetchImpl,
    })) as Json | null;
  }

  #isSeller(username: unknown): boolean {
    return typeof username === "string" && username.toLowerCase() === this.#config.sellerUsername.toLowerCase();
  }

  #map(raw: Json, conversation: Json): IngressMessage {
    const conversationId = String(conversation.conversationId);
    const outbound = this.#isSeller(raw.senderUsername);
    const sender = typeof raw.senderUsername === "string" ? raw.senderUsername : "unbekannt";
    const recipient = typeof raw.recipientUsername === "string" ? raw.recipientUsername : "";
    const reference = typeof conversation.referenceId === "string" ? conversation.referenceId : undefined;
    const title = typeof conversation.conversationTitle === "string" ? conversation.conversationTitle : typeof raw.subject === "string" ? raw.subject : "";
    return {
      externalMessageId: String(raw.messageId),
      externalThreadKey: `${PREFIX}${conversationId}`,
      resource: "conversations",
      direction: outbound ? "outbound" : "inbound",
      from: { address: `ebay:${sender.toLowerCase()}`, name: sender },
      to: recipient ? [{ address: `ebay:${recipient.toLowerCase()}`, name: recipient }] : [],
      replyTo: [],
      subject: title || `eBay-Nachricht von ${sender}`,
      bodyText: typeof raw.messageBody === "string" ? raw.messageBody.slice(0, 200_000) : "",
      receivedAt: isoOrNow(raw.createdDate),
      headers: { "x-ebay-conversation": conversationId, ...(reference ? { "x-ebay-reference": `${String(conversation.referenceType ?? "LISTING")}:${reference}` } : {}) },
      hasAttachments: Array.isArray(raw.messageMedia) && raw.messageMedia.length > 0,
      aliasKeys: [`ebay:conversation:${conversationId}`, `ebay:conversation:${conversationId}:${String(raw.messageId)}`],
    };
  }

  async #messages(conversationId: string, maxPages = 5): Promise<Json[]> {
    const out: Json[] = [];
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.#call("GET", `/conversation/${encodeURIComponent(conversationId)}`, { conversation_type: TYPE, limit: 50, offset });
      const items = Array.isArray(res?.messages) ? (res!.messages as Json[]) : [];
      out.push(...items);
      offset += items.length;
      if (!res?.next || items.length === 0) break;
    }
    return out;
  }

  async sync(cursors: Readonly<Record<string, string>>): Promise<SyncResult> {
    const since = cursorStart(cursors.conversations, this.#config.initialSyncDays ?? 14);
    const startedAt = new Date();
    const conversations: Json[] = [];
    let offset = 0;
    let complete = false;
    const max = this.#config.maxConversationsPerSync ?? 200;
    while (conversations.length < max) {
      const res = await this.#call("GET", "/conversation", { conversation_type: TYPE, start_time: since.toISOString(), limit: 50, offset });
      const items = Array.isArray(res?.conversations) ? (res!.conversations as Json[]) : [];
      conversations.push(...items);
      offset += items.length;
      if (!res?.next || items.length === 0) {
        complete = true;
        break;
      }
    }
    const messages: IngressMessage[] = [];
    for (const conversation of conversations) {
      if (!conversation.conversationId) continue;
      for (const raw of await this.#messages(String(conversation.conversationId))) {
        if (!raw.messageId) continue;
        const message = this.#map(raw, conversation);
        if (message.receivedAt.getTime() >= since.getTime()) messages.push(message);
      }
    }
    return { messages, removedExternalIds: [], cursors: complete ? { conversations: startedAt.toISOString() } : {}, cursorReset: false };
  }

  async sendReply(request: ReplyRequest): Promise<ReplyOutcome> {
    let conversationId: string;
    try {
      conversationId = threadId(request.externalThreadKey, PREFIX);
    } catch (error) {
      return { state: "rejected", error: (error as Error).message, retryable: false };
    }
    try {
      // Reply inside the existing conversation; eBay derives the buyer. No new conversations from here.
      const res = await this.#call("POST", "/send_message", {}, { conversationId, messageText: request.bodyText });
      return { state: "provider_accepted", externalMessageId: typeof res?.messageId === "string" ? res.messageId : undefined };
    } catch (error) {
      return sendFailure(error);
    }
  }

  async reconcileReply(_marker: string, since: Date, threadKey: string, sentBody: string): Promise<ReconcileOutcome> {
    try {
      const from = since.getTime() - 5 * 60_000;
      for (const m of await this.#messages(threadId(threadKey, PREFIX))) {
        if (!this.#isSeller(m.senderUsername) || isoOrNow(m.createdDate).getTime() < from) continue;
        if (typeof m.messageBody === "string" && sameText(m.messageBody, sentBody)) return { state: "found", externalMessageId: String(m.messageId) };
      }
      return { state: "not_found" };
    } catch (error) {
      return { state: "unknown", error: (error as Error).message };
    }
  }

  async checkAccess(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await this.#call("GET", "/conversation", { conversation_type: TYPE, limit: 1 });
      return { ok: true, detail: `eBay-Nachrichten lesbar für ${this.#config.sellerUsername}${res?.total !== undefined ? ` (${String(res.total)} Konversationen)` : ""}.` };
    } catch (error) {
      return { ok: false, detail: error instanceof HttpError ? error.message : (error as Error).message };
    }
  }
}
