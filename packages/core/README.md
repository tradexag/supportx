# Architecture starter: typed contracts and reply policy

This directory is a dependency-free, testable kernel. It is **not a live inbox,
an AI client, or a production connector**. It never performs network I/O or sends
a message. `MessageChannel`, `OrderProvider`, and `AiProvider` are independent
contracts; no implementation of these external integrations is included.

## What the policy demonstrates

`evaluateAutoReply` defaults to a draft. Explicit account-scoped autopilot can
produce `eligible` only when the proposed reply references the current inbound
message and conversation versions, the channel and exact reply identities are
verified, and a single verified order is linked. Every shipment must be covered
by a fresh, verified actual carrier status event. Partial shipment quantities
are represented; an order with unshipped or uncovered items stays in review.
Several `Shipment` records demonstrate split dispatches. This is not yet a
complete fulfillment/parcel model with multiple parcels beneath one shipment.

A tracking link or generated shipping label cannot support a dispatch or delivery
claim. This starter does not automate delivery estimates at all. A real delivered
event is attributed to the carrier; a disputed delivery must be flagged for review.
Overdue promised delivery, carrier exceptions, health/legal concerns, refunds,
replacement decisions, and other proposed account actions stay in review.

Only the exact `tracking-status.v1` template is eligible. Arbitrary AI text and
additional promises cannot pass by claiming a high confidence score. The future
application should use AI for classification, summaries and drafts, then map
verified facts into approved templates for this narrow automatic flow. An
AI-only safety assessment is not accepted as authorization.

## Trust boundary and remaining work

Types are not runtime validation. Callers must authenticate users, validate
unknown JSON, authorize account access, load scoped records from trusted storage,
verify the order/customer association, and run a real safety assessment. The
function checks supplied structured records; it cannot establish whether a
connector or classifier told the truth. Credentials never belong in an AI prompt.

Message sender/recipient IDs are normalized logical participants, not unchanged
email `From`/`To` values. An adapter must validate the mapping of relay addresses
and `Reply-To` values to the correct thread and permitted reply identities; these
transport addresses can differ, including with Amazon Buyer-Seller Messaging.

The caller supplies the evaluation time, making the function deterministic. The
default evidence limits are 15 minutes since observation and 72 hours since the
carrier event. These are conservative pilot defaults, not platform SLAs. Production
policies must define their own freshness and overdue rules.

An eligible decision includes the checked text and a `SendPrecondition` with
conversation, inbound, draft, reply-route and policy versions, plus route and
policy IDs. Route and policy updates must increment their versions. Before
sending, a production worker must atomically recheck all these versions, the
route identities, the currently active policy, current rights and facts, then reserve a
unique durable outbox entry using `localIdempotencyKey`. Existing reservations,
in-flight sends and uncertain delivery outcomes block a second automatic reply.

This pure function does not provide database locking, durable idempotency,
transport reconciliation, exactly-once delivery, JSON schemas, OAuth, webhook
verification, attachment processing, policy persistence, or provider approvals.
Those components remain to be built. Never expose `canAutoSend` as an unauthenticated
endpoint or turn its Boolean result directly into an unconditional API call.

## Run

From the repository root, with Node.js 24 and its built-in TypeScript stripping:

```bash
node --test tests/*.test.ts
node examples/demo.ts
```

The tests also run without process isolation if a host wrapper only reports the
test-file result: `node --test --test-isolation=none tests/*.test.ts`.
The demo contains only synthetic identities and prints decisions locally.
