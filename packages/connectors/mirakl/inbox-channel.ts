import type { AttachmentFile, AttachmentInfo, ConnectorCapabilities, IngressMessage, MessageAddress, MessageChannel, ReconcileOutcome, ReplyOutcome, ReplyRequest, SyncResult } from "../../core/contracts.ts";
import { assertAllowedEndpoint, HttpError, requestBinary, requestJson } from "../http.ts";
import { cursorStart, isoOrNow, sameText, sendFailure, threadId } from "../marketplace-common.ts";

/**
 * Mirakl seller inbox (Shop Apotheke runs on Mirakl) as a message channel.
 *
 * Documentation reviewed 2026-10-22 (docs/SOURCES.md, MIR-1..MIR-3):
 * - M11 GET /api/inbox/threads (updated_since, with_messages, shop_id, seek
 *   pagination via page_token). Messages included: last 100 per thread.
 * - M10 GET /api/inbox/threads/{thread_id}.
 * - M12 POST /api/inbox/threads/{thread_id}/message, multipart/form-data with
 *   part `message_input` {body, to: [{type, id?}]}; recipients OPERATOR, SHOP, CUSTOMER.
 * - Auth: shop API key in the Authorization header.
 * - Mirakl documents M10/M11 as "synchronous only" (called when an inbox is
 *   displayed). Background polling therefore stays off unless the operator
 *   explicitly allowed it; see `backgroundSyncAllowed` on the connection.
 *
 * Not yet verified with a real account: the operator instance URL, key scopes
 * and the order id format of MMP_ORDER entities in weclapp.
 */
export interface MiraklInboxConfig {
  /** Operator instance, e.g. https://<operator>.mirakl.net */
  baseUrl: string;
  apiKey: string;
  shopId?: string;
  initialSyncDays?: number;
  maxPagesPerSync?: number;
  timeoutMs?: number;
  allowTestEndpoints?: boolean;
  fetchImpl?: typeof fetch;
}

type Json = Record<string, unknown>;
const PREFIX = "mirakl:thread:";

export function isOfficialMiraklHost(url: URL): boolean {
  return url.hostname.endsWith(".mirakl.net");
}

function participantType(fromType: unknown): "CUSTOMER" | "OPERATOR" | "SHOP" | null {
  if (fromType === "CUSTOMER_USER") return "CUSTOMER";
  if (fromType === "OPERATOR_USER") return "OPERATOR";
  if (fromType === "SHOP_USER") return "SHOP";
  return null;
}

export class MiraklInboxChannel implements MessageChannel {
  readonly kind = "mirakl_inbox";
  readonly capabilities: ConnectorCapabilities = {
    receive: "configured",
    reply: "configured",
    attachments: "documented",
    pushNotifications: "not_implemented",
    sendReconciliation: "configured",
  };
  readonly ownAddresses: ReadonlyArray<string> = ["mirakl:shop"];
  readonly #config: MiraklInboxConfig;
  readonly #base: string;

  constructor(config: MiraklInboxConfig) {
    if (!config.apiKey?.trim()) throw new Error("Mirakl-API-Schlüssel fehlt.");
    if (config.shopId && !/^\d{1,12}$/.test(config.shopId)) throw new Error("Shop-ID muss eine Zahl sein.");
    this.#base = assertAllowedEndpoint(config.baseUrl, config.allowTestEndpoints ?? false, isOfficialMiraklHost).origin;
    this.#config = config;
  }

  async #call(method: "GET" | "POST", path: string, query: Record<string, string | number | boolean | undefined> = {}, body?: FormData): Promise<Json | null> {
    const url = new URL(`${this.#base}${path}`);
    if (this.#config.shopId) url.searchParams.set("shop_id", this.#config.shopId);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    return (await requestJson(url, {
      method,
      headers: { Authorization: this.#config.apiKey, Accept: "application/json" },
      body,
      timeoutMs: this.#config.timeoutMs ?? 20_000,
      fetchImpl: this.#config.fetchImpl,
    })) as Json | null;
  }

  #participant(thread: Json, type: "CUSTOMER" | "OPERATOR"): Json | undefined {
    const list = [...(Array.isArray(thread.current_participants) ? thread.current_participants : []), ...(Array.isArray(thread.authorized_participants) ? thread.authorized_participants : [])] as Json[];
    return list.find((p) => p.type === type);
  }

  #map(raw: Json, thread: Json): IngressMessage {
    const id = String(thread.id);
    const from = (raw.from ?? {}) as Json;
    const type = participantType(from.type);
    const outbound = type === "SHOP";
    const customer = this.#participant(thread, "CUSTOMER");
    const customerAddress: MessageAddress = {
      address: `mirakl:customer:${String(customer?.id ?? (thread.customer_organization as Json | undefined)?.id ?? id)}`,
      name: typeof customer?.display_name === "string" ? customer.display_name : undefined,
    };
    const fromName = typeof from.display_name === "string" ? from.display_name : undefined;
    const sender: MessageAddress = type === "CUSTOMER" ? { ...customerAddress, name: customerAddress.name ?? fromName } : type === "OPERATOR" ? { address: "mirakl:operator", name: fromName ?? "Marktplatz-Betreiber" } : { address: "mirakl:shop", name: fromName };
    const entities = Array.isArray(thread.entities) ? (thread.entities as Json[]) : [];
    const orders = entities.filter((e) => typeof e.type === "string" && /ORDER/.test(e.type) && e.id !== undefined).map((e) => String(e.id));
    const topic = (thread.topic ?? {}) as Json;
    return {
      externalMessageId: String(raw.id),
      externalThreadKey: `${PREFIX}${id}`,
      resource: "threads",
      direction: outbound ? "outbound" : "inbound",
      from: sender,
      to: (Array.isArray(raw.to) ? (raw.to as Json[]) : []).map((t) => ({ address: `mirakl:${String(t.type ?? "unknown").toLowerCase()}`, name: typeof t.display_name === "string" ? t.display_name : undefined })),
      replyTo: [],
      // Order ids go into the subject with a label for the normal reference extraction.
      subject: `${typeof topic.value === "string" ? topic.value : "Nachricht"}${orders.length ? ` · Bestellung ${orders.join(", Bestellung ")}` : ""}`,
      bodyText: typeof raw.body === "string" ? raw.body.slice(0, 200_000) : "",
      receivedAt: isoOrNow(raw.date_created),
      headers: { "x-mirakl-thread": id, "x-mirakl-sender-type": String(from.type ?? "unknown") },
      hasAttachments: Array.isArray(raw.attachments) && raw.attachments.length > 0,
      aliasKeys: [`mirakl:thread:${id}`, `mirakl:thread:${id}:${String(raw.id)}`],
    };
  }

  async #thread(id: string): Promise<Json> {
    return (await this.#call("GET", `/api/inbox/threads/${encodeURIComponent(id)}`)) ?? {};
  }

  async sync(cursors: Readonly<Record<string, string>>): Promise<SyncResult> {
    const since = cursorStart(cursors.threads, this.#config.initialSyncDays ?? 14);
    const startedAt = new Date();
    const messages: IngressMessage[] = [];
    let pageToken: string | undefined;
    let complete = false;
    for (let page = 0; page < (this.#config.maxPagesPerSync ?? 10); page++) {
      const res = await this.#call("GET", "/api/inbox/threads", { updated_since: since.toISOString(), with_messages: true, limit: 50, page_token: pageToken });
      for (const thread of Array.isArray(res?.data) ? (res!.data as Json[]) : []) {
        for (const raw of Array.isArray(thread.messages) ? (thread.messages as Json[]) : []) {
          if (raw.id === undefined) continue;
          const message = this.#map(raw, thread);
          if (message.receivedAt.getTime() >= since.getTime()) messages.push(message);
        }
      }
      pageToken = typeof res?.next_page_token === "string" ? res.next_page_token : undefined;
      if (!pageToken) {
        complete = true;
        break;
      }
    }
    return { messages, removedExternalIds: [], cursors: complete ? { threads: startedAt.toISOString() } : {}, cursorReset: false };
  }

  async sendReply(request: ReplyRequest): Promise<ReplyOutcome> {
    let id: string;
    let to: Array<{ type: string; id?: string }>;
    try {
      id = threadId(request.externalThreadKey, PREFIX);
      // The recipient is the author of the message being answered (customer or
      // operator), taken from the thread itself, never from the draft text.
      const thread = await this.#thread(id);
      const original = (Array.isArray(thread.messages) ? (thread.messages as Json[]) : []).find((m) => String(m.id) === request.inReplyToExternalId);
      const type = participantType((original?.from as Json | undefined)?.type);
      if (!original || (type !== "CUSTOMER" && type !== "OPERATOR")) return { state: "rejected", error: "Empfänger der Nachricht konnte im Mirakl-Vorgang nicht bestimmt werden.", retryable: false };
      const participant = this.#participant(thread, type);
      to = [{ type, ...(type === "CUSTOMER" && participant?.id !== undefined ? { id: String(participant.id) } : {}) }];
    } catch (error) {
      if (error instanceof HttpError) return { state: "rejected", error: error.message, retryable: error.retryable };
      return { state: "rejected", error: (error as Error).message, retryable: false };
    }
    try {
      const form = new FormData();
      form.set("message_input", new Blob([JSON.stringify({ body: request.bodyText, to })], { type: "application/json" }));
      const res = await this.#call("POST", `/api/inbox/threads/${encodeURIComponent(id)}/message`, {}, form);
      return { state: "provider_accepted", externalMessageId: typeof res?.message_id === "string" ? res.message_id : undefined };
    } catch (error) {
      return sendFailure(error);
    }
  }

  async reconcileReply(_marker: string, since: Date, threadKey: string, sentBody: string): Promise<ReconcileOutcome> {
    try {
      const thread = await this.#thread(threadId(threadKey, PREFIX));
      const from = since.getTime() - 5 * 60_000;
      for (const m of Array.isArray(thread.messages) ? (thread.messages as Json[]) : []) {
        if ((m.from as Json | undefined)?.type !== "SHOP_USER" || isoOrNow(m.date_created).getTime() < from) continue;
        if (typeof m.body === "string" && sameText(m.body, sentBody)) return { state: "found", externalMessageId: String(m.id) };
      }
      return { state: "not_found" };
    } catch (error) {
      return { state: "unknown", error: (error as Error).message };
    }
  }

  /** Attachments as listed on the message in the thread (M10); read when a person opens the case. */
  async listAttachments(externalMessageId: string, externalThreadKey: string): Promise<AttachmentInfo[]> {
    const thread = await this.#thread(threadId(externalThreadKey, PREFIX));
    const message = (Array.isArray(thread.messages) ? (thread.messages as Json[]) : []).find((m) => String(m.id) === externalMessageId);
    return (Array.isArray(message?.attachments) ? (message!.attachments as Json[]) : [])
      .filter((a) => a.id !== undefined)
      .map((a) => {
        const name = typeof a.name === "string" ? a.name : "Anhang";
        return { id: String(a.id), name, contentType: typeof a.type === "string" && a.type.includes("/") ? a.type.toLowerCase() : typeByName(name), size: Number(a.size ?? 0) };
      });
  }

  /** M13: GET /api/inbox/threads/{attachment_id}/download (raw file). */
  async getAttachment(externalMessageId: string, externalThreadKey: string, attachmentId: string): Promise<AttachmentFile> {
    const listed = (await this.listAttachments(externalMessageId, externalThreadKey)).find((a) => a.id === attachmentId);
    const url = new URL(`${this.#base}/api/inbox/threads/${encodeURIComponent(attachmentId)}/download`);
    if (this.#config.shopId) url.searchParams.set("shop_id", this.#config.shopId);
    const file = await requestBinary(url, { headers: { Authorization: this.#config.apiKey }, timeoutMs: this.#config.timeoutMs ?? 20_000, fetchImpl: this.#config.fetchImpl, maxBytes: 15 * 1024 * 1024 });
    const name = listed?.name ?? file.fileName ?? "Anhang";
    const contentType = file.contentType === "application/octet-stream" ? typeByName(name) : file.contentType;
    return { id: attachmentId, name, contentType, size: file.data.length, data: file.data };
  }

  async checkAccess(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.#call("GET", "/api/inbox/threads", { limit: 1 });
      return { ok: true, detail: "Mirakl-Posteingang lesbar." };
    } catch (error) {
      return { ok: false, detail: error instanceof HttpError ? error.message : (error as Error).message };
    }
  }
}

function typeByName(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", pdf: "application/pdf" } as Record<string, string>)[ext ?? ""] ?? "application/octet-stream";
}
