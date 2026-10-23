import test from "node:test";
import assert from "node:assert/strict";
import { canAutoSend, evaluateAutoReply, renderTrackingStatusReply } from "../packages/core/policy.ts";
import type { RejectionReason } from "../packages/core/policy.ts";
import type { CarrierEventEvidence, EvaluationInput } from "../packages/core/types.ts";
import { exampleContext } from "../examples/fixture.ts";

function rejects(input: EvaluationInput, reason: RejectionReason): void {
  const result = evaluateAutoReply(input);
  assert.equal(result.status, "draft");
  assert.ok(result.reasons.includes(reason), `${reason}: ${JSON.stringify(result)}`);
  assert.equal(canAutoSend(input), false);
}

test("defaults to drafts; AI confidence does not enable autopilot", () => {
  const input = exampleContext();
  input.policy = undefined;
  input.draft.aiConfidence = 1;
  rejects(input, "AUTOPILOT_DISABLED");
});

test("verified WISMO facts allow only the canonical template and bind current versions", () => {
  const input = exampleContext();
  const result = evaluateAutoReply(input);
  assert.equal(result.status, "eligible");
  if (result.status !== "eligible") return;
  assert.equal(result.text, input.draft.body);
  assert.equal(result.recipientId, input.inbound.senderId);
  assert.equal(result.precondition.expectedConversationVersion, 3);
  assert.equal(result.precondition.expectedDraftVersion, 2);
  assert.equal(result.precondition.expectedInboundVersion, 1);
  assert.equal(result.precondition.routeId, "demo-route");
  assert.equal(result.precondition.expectedRouteVersion, 1);
  assert.equal(result.precondition.policyId, "demo-policy");
  assert.equal(result.precondition.expectedPolicyVersion, 1);
  assert.equal(canAutoSend(input), true);
  assert.deepEqual(result, evaluateAutoReply(input));
});

test("account/workspace isolation applies to route, order, evidence and policy", () => {
  for (const target of ["order", "evidence", "route", "policy"] as const) {
    const input = exampleContext();
    if (target === "order" && input.orderMatch.kind === "unique") input.orderMatch.order.accountId = "other-seller";
    if (target === "evidence") input.evidence[0]!.workspaceId = "other-workspace";
    if (target === "route") input.conversation.replyRoute.accountId = "other-seller";
    if (target === "policy" && input.policy) input.policy.workspaceId = "other-workspace";
    rejects(input, "SCOPE_MISMATCH");
  }
});

test("missing, ambiguous, and unverified order matches require review", () => {
  const input = exampleContext();
  input.orderMatch = { kind: "missing" };
  rejects(input, "ORDER_NOT_UNIQUE");
  input.orderMatch = { kind: "ambiguous", candidateIds: ["demo-order", "another-order"] };
  rejects(input, "ORDER_NOT_UNIQUE");
  const unverified = exampleContext();
  if (unverified.orderMatch.kind === "unique") unverified.orderMatch.verified = false;
  rejects(unverified, "ORDER_NOT_UNIQUE");
});

test("stale observations, old events, future timestamps and overdue orders block autopilot", () => {
  const stale = exampleContext();
  stale.evidence[0]!.observedAtMs = stale.nowMs - 60 * 60 * 1000;
  rejects(stale, "EVIDENCE_STALE");
  const old = exampleContext();
  (old.evidence[0]! as CarrierEventEvidence).occurredAtMs = old.nowMs - 96 * 60 * 60 * 1000;
  rejects(old, "EVIDENCE_STALE");
  const future = exampleContext();
  future.evidence[0]!.observedAtMs = future.nowMs + 1;
  rejects(future, "EVIDENCE_STALE");
  const invalid = exampleContext();
  invalid.nowMs = Number.MAX_VALUE;
  (invalid.evidence[0]! as CarrierEventEvidence).occurredAtMs = Number.MAX_VALUE;
  invalid.evidence[0]!.observedAtMs = Number.MAX_VALUE;
  rejects(invalid, "INVALID_POLICY_OR_TIME");
  const overdue = exampleContext();
  if (overdue.orderMatch.kind === "unique") overdue.orderMatch.order.latestPromisedDeliveryAtMs = overdue.nowMs - 1;
  rejects(overdue, "DELIVERY_OVERDUE");
});

test("a tracking link cannot prove dispatch or delivery; arbitrary ETA text is rejected", () => {
  const input = exampleContext();
  const fact = input.evidence[0]!;
  input.evidence = [{
    workspaceId: fact.workspaceId, accountId: fact.accountId,
    id: fact.id, orderId: fact.orderId, shipmentId: fact.shipmentId,
    sourceRecordId: fact.sourceRecordId, observedAtMs: fact.observedAtMs,
    verified: true, kind: "tracking_reference", trackingNumber: "DEMO-TRACKING",
    trackingUrl: "https://example.invalid/track/DEMO-TRACKING",
  }];
  rejects(input, "EVIDENCE_INVALID");
  input.draft.claims = [{ ...input.draft.claims[0]!, status: "delivered" }];
  rejects(input, "EVIDENCE_INVALID");
  const eta = exampleContext();
  eta.draft.body += "\nDas Paket kommt morgen garantiert an.";
  rejects(eta, "TEMPLATE_REQUIRED");
  eta.draft.format = "free_text";
  rejects(eta, "TEMPLATE_REQUIRED");
});

test("reservations, successful sends and unknown delivery outcomes all prevent duplicates", () => {
  for (const state of ["reserved", "sending", "sent", "unknown"] as const) {
    const input = exampleContext();
    input.replyLedger = [{
      workspaceId: input.workspaceId, accountId: input.accountId,
      conversationId: input.conversation.id, inboundMessageId: input.inbound.id, state,
    }];
    rejects(input, "INBOUND_ALREADY_HANDLED");
  }
});

test("a draft cannot choose a different recipient or sender, or an unverified reply route", () => {
  const recipient = exampleContext();
  recipient.draft.recipientId = "unrelated-person";
  rejects(recipient, "RECIPIENT_MISMATCH");
  const sender = exampleContext();
  sender.draft.senderId = "unrelated-mailbox";
  rejects(sender, "SENDER_MISMATCH");
  const route = exampleContext();
  route.conversation.replyRoute.verification = "unverified";
  rejects(route, "ROUTE_UNVERIFIED");
});

test("unverified capabilities and missing account access never authorize a native reply", () => {
  for (const capability of ["unsupported", "unverified"] as const) {
    const input = exampleContext();
    input.channel.capabilities.sendReply = capability;
    rejects(input, "CHANNEL_UNVERIFIED");
  }
  const input = exampleContext();
  input.channel.accountAccess = "unverified";
  rejects(input, "CHANNEL_UNVERIFIED");
});

test("versions bind conversation, inbound, reply route and active policy", () => {
  const conversation = exampleContext();
  conversation.conversation.version += 1;
  rejects(conversation, "STALE_DRAFT");
  const inbound = exampleContext();
  inbound.conversation.latestInboundId = "new-inbound";
  rejects(inbound, "STALE_DRAFT");
  const version = exampleContext();
  version.inbound.version += 1;
  rejects(version, "STALE_DRAFT");
  const route = exampleContext();
  route.conversation.replyRoute.version = 0;
  rejects(route, "ROUTE_UNVERIFIED");
  const policy = exampleContext();
  if (policy.policy) policy.policy.version = 0;
  rejects(policy, "INVALID_POLICY_OR_TIME");
  const changed = exampleContext();
  const before = evaluateAutoReply(changed);
  assert.equal(before.status, "eligible");
  if (before.status !== "eligible" || !changed.policy) return;
  changed.conversation.replyRoute.version += 1;
  changed.policy.version += 1;
  // The future atomic worker must reject the old decision against these values.
  assert.notEqual(before.precondition.expectedRouteVersion, changed.conversation.replyRoute.version);
  assert.notEqual(before.precondition.expectedPolicyVersion, changed.policy.version);
  const refreshed = evaluateAutoReply(changed);
  assert.equal(refreshed.status, "eligible");
  if (refreshed.status === "eligible") {
    assert.equal(refreshed.precondition.expectedRouteVersion, 2);
    assert.equal(refreshed.precondition.expectedPolicyVersion, 2);
  }
  changed.policy.mode = "draft";
  rejects(changed, "AUTOPILOT_DISABLED");
});

test("health/legal/refund/replacement/disputed delivery, AI-only screening and money actions require review", () => {
  for (const risk of ["health", "legal", "refund", "replacement", "delivery_disputed"] as const) {
    const input = exampleContext();
    input.safety.risks = [risk];
    rejects(input, "SAFETY_REVIEW_REQUIRED");
  }
  const ai = exampleContext();
  ai.safety.assessedBy = "ai_only";
  rejects(ai, "SAFETY_REVIEW_REQUIRED");
  const money = exampleContext();
  money.draft.requestedActions = ["send_message", "refund"];
  rejects(money, "ACTION_NOT_ALLOWED");
});

test("split shipments need complete coverage and latest consistent actual events", () => {
  const input = exampleContext();
  assert.equal(input.orderMatch.kind, "unique");
  if (input.orderMatch.kind !== "unique") return;
  input.orderMatch.order.shipments = [
    { ...input.orderMatch.order.shipments[0]!, items: [{ orderLineId: "demo-line", quantity: 1 }] },
    { ...input.orderMatch.order.shipments[0]!, id: "second-shipment", items: [{ orderLineId: "demo-line", quantity: 1 }] },
  ];
  rejects(input, "EVIDENCE_INVALID");
  const first = input.evidence[0]! as CarrierEventEvidence;
  const second: CarrierEventEvidence = { ...first, id: "second-event", shipmentId: "second-shipment", status: "accepted" };
  input.evidence = [first, second];
  input.draft.claims = [...input.draft.claims, { kind: "shipment_status", shipmentId: "second-shipment", evidenceId: "second-event", status: "accepted" }];
  input.draft.body = renderTrackingStatusReply([first, second]);
  assert.equal(canAutoSend(input), true);
  input.evidence = [...input.evidence, { ...first, id: "newer-event", status: "exception", occurredAtMs: first.occurredAtMs + 1 }];
  rejects(input, "EVIDENCE_INVALID");
});
