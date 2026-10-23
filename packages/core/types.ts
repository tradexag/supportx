/** Policy-kernel types. Service contracts: see contracts.ts. */
export type Capability = "supported" | "unsupported" | "unverified";

/** Every entity belongs to one installation workspace and one seller account. */
export interface AccountScope {
  workspaceId: string;
  accountId: string;
}

export interface ChannelCapabilities {
  receiveMessages: Capability;
  sendReply: Capability;
  attachments: Capability;
  webhook: Capability;
  nativeIdempotency: Capability;
}

export interface ChannelRegistration extends AccountScope {
  id: string;
  capabilities: ChannelCapabilities;
  /** Granted permissions must be checked for this account, not just in docs. */
  accountAccess: "verified" | "unverified" | "denied";
}

export interface ReplyRoute extends AccountScope {
  id: string;
  version: number;
  channelId: string;
  /** Normalized logical identities, not raw transport From/To addresses. */
  senderId: string;
  recipientId: string;
  /** Derived by the connector from the original thread; never chosen by an LLM. */
  verification: "verified" | "unverified";
  verifiedForInboundId: string;
}

export interface Conversation extends AccountScope {
  id: string;
  version: number;
  channelId: string;
  externalConversationId: string;
  latestInboundId: string;
  latestInboundVersion: number;
  replyRoute: ReplyRoute;
}

export interface Message extends AccountScope {
  id: string;
  version: number;
  conversationId: string;
  channelId: string;
  externalMessageId: string;
  direction: "inbound" | "outbound";
  /**
   * Logical participants normalized by the connector, NOT verbatim email From/To.
   * Relay and Reply-To transport addresses can differ (for example on Amazon).
   * The adapter must validate their mapping to the original thread and reply route.
   */
  senderId: string;
  recipientId: string;
  body: string;
  receivedAtMs: number;
}

export interface OrderLine {
  id: string;
  sku: string;
  quantity: number;
}

/**
 * A shipment can contain partial quantities; an order may have many shipments.
 * This starter is not a complete fulfillment -> parcel model: several Shipment
 * records demonstrate split dispatches, without separate parcels under a shipment.
 */
export interface Shipment extends AccountScope {
  id: string;
  orderId: string;
  items: ReadonlyArray<{ orderLineId: string; quantity: number }>;
}

export interface Order extends AccountScope {
  id: string;
  externalOrderId: string;
  lines: ReadonlyArray<OrderLine>;
  shipments: ReadonlyArray<Shipment>;
  latestPromisedDeliveryAtMs?: number;
}

export type OrderMatch =
  | { kind: "unique"; order: Order; verified: boolean }
  | { kind: "ambiguous"; candidateIds: ReadonlyArray<string> }
  | { kind: "missing" };

interface EvidenceBase extends AccountScope {
  id: string;
  orderId: string;
  shipmentId: string;
  sourceRecordId: string;
  observedAtMs: number;
  verified: boolean;
}

export type ShipmentStatus =
  | "accepted"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "exception";

/** Only an actual status event can support a status statement. */
export interface CarrierEventEvidence extends EvidenceBase {
  kind: "carrier_event";
  source: "carrier_api" | "marketplace_api" | "erp_carrier_event";
  status: ShipmentStatus;
  occurredAtMs: number;
}

/** A label or tracking URL is not evidence of dispatch, delivery, or an ETA. */
export interface TrackingReferenceEvidence extends EvidenceBase {
  kind: "tracking_reference";
  trackingNumber: string;
  trackingUrl?: string;
}

export type ShipmentEvidence = CarrierEventEvidence | TrackingReferenceEvidence;

export interface StatusClaim {
  kind: "shipment_status";
  shipmentId: string;
  evidenceId: string;
  status: ShipmentStatus;
}

export type Intent = "wismo" | "wrong_item" | "return" | "refund" | "other";
export type Risk =
  | "health"
  | "legal"
  | "refund"
  | "replacement"
  | "delivery_disputed"
  | "identity_uncertain"
  | "other";

export interface SafetyScreen {
  status: "cleared" | "needs_review" | "unknown";
  assessedBy: "rules" | "human" | "ai_only";
  risks: ReadonlyArray<Risk>;
}

export interface ReplyDraft extends AccountScope {
  id: string;
  version: number;
  conversationId: string;
  basedOnConversationVersion: number;
  inboundMessageId: string;
  inboundMessageVersion: number;
  channelId: string;
  senderId: string;
  recipientId: string;
  intent: Intent;
  requestedActions: ReadonlyArray<"send_message" | "refund" | "replace" | "cancel">;
  format: "tracking-status.v1" | "free_text";
  body: string;
  claims: ReadonlyArray<StatusClaim>;
  /** Informational only; never sufficient to permit sending. */
  aiConfidence?: number;
}

export interface AutoReplyPolicy extends AccountScope {
  id: string;
  version: number;
  mode: "draft" | "autopilot";
  maxObservationAgeMs?: number;
  maxEventAgeMs?: number;
}

/** Durable state loaded from the database at evaluation time. */
export interface ReplyLedgerEntry extends AccountScope {
  conversationId: string;
  inboundMessageId: string;
  state: "reserved" | "sending" | "sent" | "unknown";
}

export interface EvaluationInput extends AccountScope {
  nowMs: number;
  policy?: AutoReplyPolicy;
  channel: ChannelRegistration;
  conversation: Conversation;
  inbound: Message;
  draft: ReplyDraft;
  orderMatch: OrderMatch;
  evidence: ReadonlyArray<ShipmentEvidence>;
  safety: SafetyScreen;
  replyLedger: ReadonlyArray<ReplyLedgerEntry>;
}

/**
 * The service-level MessageChannel, OrderProvider and AiProvider contracts live in
 * contracts.ts. The types above describe the pure auto-reply policy kernel.
 */
