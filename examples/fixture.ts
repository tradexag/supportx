import type { CarrierEventEvidence, EvaluationInput } from "../packages/core/types.ts";
import { renderTrackingStatusReply } from "../packages/core/policy.ts";

/** Synthetic data only. This factory has no network or external side effects. */
export function exampleContext(): EvaluationInput {
  const scope = { workspaceId: "demo-workspace", accountId: "demo-seller" };
  const nowMs = Date.parse("2026-10-21T08:00:00Z");
  const event: CarrierEventEvidence = {
    ...scope, id: "demo-event", orderId: "demo-order", shipmentId: "demo-shipment",
    sourceRecordId: "demo-carrier-record", kind: "carrier_event", source: "carrier_api",
    status: "in_transit", verified: true,
    observedAtMs: nowMs - 60_000, occurredAtMs: nowMs - 3_600_000,
  };
  return {
    ...scope, nowMs,
    policy: { ...scope, id: "demo-policy", version: 1, mode: "autopilot" },
    channel: {
      ...scope, id: "demo-channel", accountAccess: "verified",
      capabilities: {
        receiveMessages: "supported", sendReply: "supported", attachments: "unverified",
        webhook: "unsupported", nativeIdempotency: "unverified",
      },
    },
    conversation: {
      ...scope, id: "demo-conversation", version: 3, channelId: "demo-channel",
      externalConversationId: "synthetic-thread", latestInboundId: "demo-inbound",
      latestInboundVersion: 1,
      replyRoute: {
        ...scope, id: "demo-route", version: 1,
        channelId: "demo-channel", senderId: "demo-support-identity",
        recipientId: "demo-buyer-identity", verification: "verified",
        verifiedForInboundId: "demo-inbound",
      },
    },
    inbound: {
      ...scope, id: "demo-inbound", version: 1, conversationId: "demo-conversation",
      channelId: "demo-channel", externalMessageId: "synthetic-message",
      direction: "inbound", senderId: "demo-buyer-identity", recipientId: "demo-support-identity",
      body: "Wo ist mein Paket?", receivedAtMs: nowMs - 120_000,
    },
    draft: {
      ...scope, id: "demo-draft", version: 2, conversationId: "demo-conversation",
      basedOnConversationVersion: 3, inboundMessageId: "demo-inbound", inboundMessageVersion: 1,
      channelId: "demo-channel", senderId: "demo-support-identity", recipientId: "demo-buyer-identity",
      intent: "wismo", requestedActions: ["send_message"], format: "tracking-status.v1",
      body: renderTrackingStatusReply([event]),
      claims: [{ kind: "shipment_status", shipmentId: "demo-shipment", evidenceId: "demo-event", status: "in_transit" }],
      aiConfidence: 0.99,
    },
    orderMatch: {
      kind: "unique", verified: true,
      order: {
        ...scope, id: "demo-order", externalOrderId: "synthetic-order",
        lines: [{ id: "demo-line", sku: "DEMO-SKU", quantity: 2 }],
        shipments: [{ ...scope, id: "demo-shipment", orderId: "demo-order", items: [{ orderLineId: "demo-line", quantity: 2 }] }],
      },
    },
    evidence: [event],
    safety: { status: "cleared", assessedBy: "rules", risks: [] },
    replyLedger: [],
  };
}
