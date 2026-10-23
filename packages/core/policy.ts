import type {
  AccountScope,
  CarrierEventEvidence,
  EvaluationInput,
  ShipmentStatus,
} from "./types.ts";

export type RejectionReason =
  | "AUTOPILOT_DISABLED"
  | "INVALID_POLICY_OR_TIME"
  | "SCOPE_MISMATCH"
  | "CHANNEL_UNVERIFIED"
  | "ROUTE_UNVERIFIED"
  | "RECIPIENT_MISMATCH"
  | "SENDER_MISMATCH"
  | "STALE_DRAFT"
  | "INBOUND_ALREADY_HANDLED"
  | "INTENT_NOT_ALLOWED"
  | "SAFETY_REVIEW_REQUIRED"
  | "ACTION_NOT_ALLOWED"
  | "ORDER_NOT_UNIQUE"
  | "ORDER_INVALID"
  | "DELIVERY_OVERDUE"
  | "EVIDENCE_INVALID"
  | "EVIDENCE_STALE"
  | "SHIPMENT_EXCEPTION"
  | "TEMPLATE_REQUIRED";

export interface SendPrecondition {
  workspaceId: string;
  accountId: string;
  channelId: string;
  conversationId: string;
  expectedConversationVersion: number;
  inboundMessageId: string;
  expectedInboundVersion: number;
  draftId: string;
  expectedDraftVersion: number;
  routeId: string;
  expectedRouteVersion: number;
  policyId: string;
  expectedPolicyVersion: number;
  /** This key must be protected by a unique database constraint. */
  localIdempotencyKey: string;
}

export type AutoReplyDecision =
  | { status: "draft"; reasons: ReadonlyArray<RejectionReason> }
  | {
      status: "eligible";
      reasons: readonly [];
      /** Use this checked template output, never an unchecked AI body. */
      text: string;
      senderId: string;
      recipientId: string;
      precondition: SendPrecondition;
    };

function sameScope(a: AccountScope, b: AccountScope): boolean {
  return a.workspaceId === b.workspaceId && a.accountId === b.accountId;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validTime(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && !Number.isNaN(new Date(value).getTime());
}

const STATUS_TEXT: Record<ShipmentStatus, string> = {
  accepted: "vom Versanddienstleister übernommen",
  in_transit: "unterwegs",
  out_for_delivery: "in Zustellung",
  delivered: "als zugestellt gemeldet",
  exception: "mit einer Versandabweichung gemeldet",
};

/**
 * Small fixed German template for the pilot. It makes no delivery promise/ETA.
 * A delivered event is explicitly attributed to the carrier, not to the buyer.
 * Rendering is NOT validation: evaluateAutoReply must check the underlying facts.
 */
export function renderTrackingStatusReply(events: ReadonlyArray<CarrierEventEvidence>): string {
  const lines = events.map((event, index) =>
    `- Sendung ${index + 1}: ${STATUS_TEXT[event.status]} ` +
    `(Versandmeldung vom ${new Date(event.occurredAtMs).toISOString()}).`,
  );
  return [
    "Guten Tag,",
    "",
    "zu Ihrer Bestellung liegen folgende Meldungen des Versanddienstleisters vor:",
    ...lines,
    "",
    "Freundliche Grüße",
    "Ihr Kundenservice",
  ].join("\n");
}

/**
 * Pure, point-in-time eligibility check. It does not authenticate callers, parse
 * unknown JSON, prove the semantic safety of incoming text, call AI, or send.
 * All records must come from validated storage/connectors, not LLM assertions.
 * A production worker MUST recheck these versions, rights and facts atomically
 * with a unique outbox reservation, then reconcile ambiguous transport results.
 * `eligible` alone cannot provide exactly-once delivery or prevent later races.
 */
export function evaluateAutoReply(input: EvaluationInput): AutoReplyDecision {
  const reasons = new Set<RejectionReason>();
  const reject = (reason: RejectionReason) => { reasons.add(reason); };
  const { policy, channel, conversation, inbound, draft } = input;
  if (policy?.mode !== "autopilot") reject("AUTOPILOT_DISABLED");
  const maxObservationAgeMs = policy?.maxObservationAgeMs ?? 15 * 60 * 1000;
  const maxEventAgeMs = policy?.maxEventAgeMs ?? 72 * 60 * 60 * 1000;
  if (!validTime(input.nowMs) ||
      !Number.isFinite(maxObservationAgeMs) || maxObservationAgeMs <= 0 ||
      !Number.isFinite(maxEventAgeMs) || maxEventAgeMs <= 0 ||
      (policy !== undefined && (!policy.id || !positiveInteger(policy.version)))) {
    reject("INVALID_POLICY_OR_TIME");
  }
  if (!input.workspaceId || !input.accountId ||
      [channel, conversation, inbound, draft, conversation.replyRoute,
       ...(policy ? [policy] : [])].some((entity) => !sameScope(input, entity))) {
    reject("SCOPE_MISMATCH");
  }
  if (input.evidence.some((fact) => !sameScope(input, fact))) reject("SCOPE_MISMATCH");
  if (!channel.id || channel.accountAccess !== "verified" ||
      channel.capabilities.receiveMessages !== "supported" ||
      channel.capabilities.sendReply !== "supported" ||
      [conversation.channelId, inbound.channelId, draft.channelId,
       conversation.replyRoute.channelId].some((id) => id !== channel.id)) {
    reject("CHANNEL_UNVERIFIED");
  }
  const route = conversation.replyRoute;
  if (!route.id || !positiveInteger(route.version) ||
      route.verification !== "verified" || route.verifiedForInboundId !== inbound.id) {
    reject("ROUTE_UNVERIFIED");
  }
  if (!route.recipientId || draft.recipientId !== route.recipientId ||
      inbound.senderId !== route.recipientId) reject("RECIPIENT_MISMATCH");
  if (!route.senderId || draft.senderId !== route.senderId ||
      inbound.recipientId !== route.senderId) reject("SENDER_MISMATCH");
  if (!conversation.id || !conversation.externalConversationId || !inbound.id ||
      !draft.id || inbound.direction !== "inbound" ||
      ![conversation.version, conversation.latestInboundVersion, inbound.version,
        draft.version, draft.basedOnConversationVersion, draft.inboundMessageVersion]
        .every(positiveInteger) ||
      inbound.conversationId !== conversation.id || draft.conversationId !== conversation.id ||
      conversation.latestInboundId !== inbound.id ||
      conversation.latestInboundVersion !== inbound.version ||
      draft.inboundMessageId !== inbound.id || draft.inboundMessageVersion !== inbound.version ||
      draft.basedOnConversationVersion !== conversation.version) reject("STALE_DRAFT");
  if (input.replyLedger.some((entry) => sameScope(input, entry) &&
      entry.conversationId === conversation.id && entry.inboundMessageId === inbound.id)) {
    // A reservation or ambiguous transport result is also handled until reconciled.
    reject("INBOUND_ALREADY_HANDLED");
  }
  if (draft.intent !== "wismo") reject("INTENT_NOT_ALLOWED");
  if (input.safety.status !== "cleared" || !["rules", "human"].includes(input.safety.assessedBy) ||
      input.safety.risks.length !== 0) reject("SAFETY_REVIEW_REQUIRED");
  if (draft.requestedActions.length !== 1 || draft.requestedActions[0] !== "send_message") {
    reject("ACTION_NOT_ALLOWED");
  }

  const events: CarrierEventEvidence[] = [];
  if (input.orderMatch.kind !== "unique" || input.orderMatch.verified !== true) {
    reject("ORDER_NOT_UNIQUE");
  } else {
    const order = input.orderMatch.order;
    if (!sameScope(input, order) || order.shipments.some((s) => !sameScope(input, s))) {
      reject("SCOPE_MISMATCH");
    }
    const lineIds = new Set(order.lines.map((line) => line.id));
    const shipmentIds = new Set(order.shipments.map((shipment) => shipment.id));
    const shippedQuantities = new Map<string, number>();
    if (!order.id || !order.externalOrderId || order.lines.length === 0 ||
        lineIds.size !== order.lines.length ||
        order.lines.some((line) => !line.id || !positiveInteger(line.quantity)) ||
        order.shipments.length === 0 || shipmentIds.size !== order.shipments.length ||
        order.shipments.some((shipment) => !shipment.id || shipment.orderId !== order.id ||
          shipment.items.length === 0 || shipment.items.some((item) =>
            !lineIds.has(item.orderLineId) || !positiveInteger(item.quantity)))) {
      reject("ORDER_INVALID");
    }
    for (const shipment of order.shipments) {
      for (const item of shipment.items) {
        shippedQuantities.set(item.orderLineId,
          (shippedQuantities.get(item.orderLineId) ?? 0) + item.quantity);
      }
    }
    // This starter only automates complete shipment coverage; partial/unshipped
    // lines need the richer workflow and must not silently disappear in a reply.
    if (order.lines.some((line) => shippedQuantities.get(line.id) !== line.quantity)) {
      reject("ORDER_INVALID");
    }
    if (order.latestPromisedDeliveryAtMs !== undefined &&
        (!validTime(order.latestPromisedDeliveryAtMs) ||
         order.latestPromisedDeliveryAtMs < input.nowMs)) reject("DELIVERY_OVERDUE");

    const claimedShipments = new Set(draft.claims.map((claim) => claim.shipmentId));
    const evidenceIds = new Set(input.evidence.map((item) => item.id));
    if (draft.claims.length === 0 || claimedShipments.size !== draft.claims.length ||
        claimedShipments.size !== shipmentIds.size ||
        evidenceIds.size !== input.evidence.length ||
        [...claimedShipments].some((id) => !shipmentIds.has(id))) {
      reject("EVIDENCE_INVALID");
    }
    for (const claim of draft.claims) {
      const fact = input.evidence.find((item) => item.id === claim.evidenceId);
      if (fact && !sameScope(input, fact)) reject("SCOPE_MISMATCH");
      if (claim.kind !== "shipment_status" || !fact || fact.kind !== "carrier_event" ||
          fact.verified !== true || !fact.sourceRecordId ||
          !["carrier_api", "marketplace_api", "erp_carrier_event"].includes(fact.source) ||
          fact.orderId !== order.id || fact.shipmentId !== claim.shipmentId ||
          fact.status !== claim.status || !Object.hasOwn(STATUS_TEXT, fact.status)) {
        reject("EVIDENCE_INVALID");
        continue;
      }
      const timesValid = validTime(fact.observedAtMs) && validTime(fact.occurredAtMs) &&
        fact.occurredAtMs <= fact.observedAtMs && fact.observedAtMs <= input.nowMs;
      if (!timesValid || input.nowMs - fact.observedAtMs > maxObservationAgeMs ||
          input.nowMs - fact.occurredAtMs > maxEventAgeMs) reject("EVIDENCE_STALE");
      if (fact.status === "exception") reject("SHIPMENT_EXCEPTION");
      // A newer verified event takes precedence. Equal event time with a
      // contradictory status is also ambiguous and must be reviewed.
      if (input.evidence.some((other) => other.kind === "carrier_event" &&
          sameScope(input, other) && other.verified && other.orderId === order.id &&
          other.shipmentId === fact.shipmentId && other.id !== fact.id &&
          (other.occurredAtMs > fact.occurredAtMs ||
           (other.occurredAtMs === fact.occurredAtMs && other.status !== fact.status)))) {
        reject("EVIDENCE_INVALID");
      }
      if (timesValid) events.push(fact);
    }
  }
  const rendered = events.length > 0 ? renderTrackingStatusReply(events) : "";
  if (draft.format !== "tracking-status.v1" || !rendered || draft.body !== rendered) {
    reject("TEMPLATE_REQUIRED");
  }
  if (reasons.size > 0 || !policy) return { status: "draft", reasons: [...reasons] };
  return {
    status: "eligible",
    reasons: [],
    text: rendered,
    senderId: route.senderId,
    recipientId: route.recipientId,
    precondition: {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      channelId: channel.id,
      conversationId: conversation.id,
      expectedConversationVersion: conversation.version,
      inboundMessageId: inbound.id,
      expectedInboundVersion: inbound.version,
      draftId: draft.id,
      expectedDraftVersion: draft.version,
      routeId: route.id,
      expectedRouteVersion: route.version,
      policyId: policy.id,
      expectedPolicyVersion: policy.version,
      localIdempotencyKey: JSON.stringify([
        "reply.v1", input.workspaceId, input.accountId, channel.id,
        conversation.id, inbound.id,
      ]),
    },
  };
}

/** Convenience predicate only; use the full decision/preconditions for a worker. */
export function canAutoSend(input: EvaluationInput): boolean {
  return evaluateAutoReply(input).status === "eligible";
}
