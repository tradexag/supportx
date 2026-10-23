# Implementation backlog

Status: proposed milestones, not elapsed-time estimates or completed integrations. Dependencies and acceptance criteria determine readiness. The owner has confirmed weclapp as the only order-data source for v1; additional platform order imports are outside this build.

## M0 — Prove access and data mapping

- Inventory the pilot mailbox, seller accounts and Microsoft account type. Use the already selected weclapp connection as the order-data source.
- Examine a small, de-identified sample of tracking, wrong-item, damaged-item, return and invoice cases.
- Verify marketplace order ID to ERP order, line item, shipment and parcel mappings per seller account.
- Verify Amazon approved sender and reply route in a controlled conversation.
- Resolve Shop Apotheke permitted background synchronization. DocMorris incoming email is confirmed by the owner; inspect a real message to establish the reply route and order references.
- Preserve existing weclapp integrations when planning credentials; do not rotate an active user's token blindly.

**Exit:** a capability record for each pilot connection, with unknowns explicitly disabled and concrete account evidence for the first implemented route.

## Status 2026-10-21 (version 0.1.0)

- **M0:** open; needs the operator's accounts (see docs/SETUP.de.md and the account-test list in CONNECTORS.md).
- **M1:** implemented and tested against test doubles; exit criterion “pilot message from a real mailbox” pending live access.
- **M2:** Claude provider, proposal schema, prompt versioning, evidence display, editing, versioned approvals, outbox, Microsoft reply and reconciliation implemented. Pending: knowledge base, Amazon relay and DocMorris route verification with real messages, live controlled reply.
- **M3–M6:** not started, except Docker Compose/CI files (untested in Docker) and the `MessageChannel` contract with alias keys.
- **Update 2026-10-22 (0.2.0):** native eBay, Kaufland and Shop Apotheke (Mirakl) channels implemented and tested against test doubles (M3 and the Mirakl part of M4). Open: account tests per marketplace, attachments, eBay `NEW_MESSAGE` push, merging e-mail copies of native messages via alias keys.

**Next step:** M0/M1 live acceptance — connect the real Microsoft service mailbox (RBAC-scoped, read-only) and a read-only weclapp user, run in drafts-only mode for a pilot period, verify field mapping, routing rules and match quality on real messages; then verify the DocMorris and Amazon reply routes with one controlled reply each.

## M1 — Deliver one real Microsoft + ERP slice

- Implement authentication, workspace membership, account-scoped repositories, encrypted secret references and migrations.
- Add the Microsoft connection wizard with explicit mailbox selection and scoped permissions.
- Implement mailbox ingestion, paging, delta reconciliation, subscription renewal and send-echo suppression.
- Include the confirmed DocMorris email stream in this ingestion, preserve original identifiers and headers, classify the source and match the scoped weclapp order. Do not wait for a separate DocMorris API integration.
- Implement read-only order and parcel enrichment and unambiguous order linking.
- Build the case list/detail screens, internal notes and manual assignment.
- Add a reproducible local environment and static type checking with a pinned dependency lockfile.

**Exit:** a pilot message appears once, can be reviewed with correct scoped context, and survives a worker restart. Missing order matches are visible. No live unattended send is enabled.

## M2 — Drafts, review and email replies

- Implement the initial Claude `AiProvider`, a common proposal schema, prompt versions and request budgets.
- Build a restricted knowledge base for approved support rules and templates; avoid a broad vector store until justified.
- Add evidence display, editing, versioned approvals and a transactional outbox.
- Implement Microsoft reply and the specialized Amazon relay routing policy.
- Verify the DocMorris email Reply-To/provenance and a controlled reply reaching the correct external thread before enabling outbound replies. Ingestion and drafts remain usable while this reply capability is unverified.
- Reconcile remote acceptance, failures and external manual replies where available.

**Exit:** a controlled answer reaches the correct external thread from the approved sender. A changed draft or new customer message invalidates stale approval. A send timeout cannot create an uncontrolled retry loop.

## M3 — Native Kaufland and eBay channels

- Kaufland: tickets, messages, attachments, configured polling and responsibility state.
- eBay: Commerce Message API, OAuth, paginated conversations and available notifications.
- Add explicit aliases for verified email copies of native messages.
- Preserve independent conversations for different merchant accounts and separate orders/threads.

**Exit:** a native reply is visible in its original conversation; ten repeated ingress events produce one stored message; a second real customer message with identical text remains distinct. Internal notes never use a customer-visible API operation.

## M4 — Remaining platform coverage

- Shop Apotheke: Mirakl operator profile, verified participants, permissions and allowed sync strategy.
- Shopify support email is already covered by Microsoft; do not build a Shopify Admin API order connector. Investigate existing Inbox chats only if the operator actually uses them.
- DocMorris email ingestion is already part of M1 and reply verification of M2; do not add a native DocMorris API connector for this scope.
- Make unavailable/unverified features obvious in onboarding and case actions.

**Exit:** each advertised capability has an account test. No native Shopify Inbox or DocMorris messaging is claimed based only on an order API. No unauthorized Mirakl polling strategy is enabled.

## M5 — Limited unattended operation and MCP

- Enable a narrow tracking policy per verified account, using deterministic templates and fresh weclapp evidence. Implement a separate neutral link-only template when carrier scans are absent; do not turn a tracking link into a shipment or delivery claim.
- Add per-account pause, limits, failure queue and explicit approval for changed workflows.
- Expose authenticated MCP tools through the common application services.
- Test a second AI adapter against the same contract before describing provider independence as implemented end to end.
- Measure corrected drafts, wrong order links, duplicate sends, reopened cases, latency and cost per resolved case.

**Exit:** automation passes an operator-reviewed pilot sample, keeps evidence and never bypasses the same policy through MCP. Financial actions remain disabled unless separately implemented and approved.

## M6 — Public release

- Choose GitHub owner, repository name and copyright holder.
- Add tested Docker Compose, migrations, backup/restore instructions and a short operator runbook.
- Publish CI that exercises meaningful domain, isolation, replay and dispatch-failure scenarios.
- Confirm dependency license compatibility and preserve required notices.
- Scan committed files for secrets and real personal records; use synthetic fixtures.
- Provide platform setup guides explaining own-account versus partner/public-app access.
- Enable private security reporting and publish accurately scoped connector status.

**Exit:** another operator can install the project from the documented release, bring their own credentials and reproduce the tested workflow without access to the original developer's infrastructure.

## Later action workflows

Returns, replacements, refunds and cancellations receive distinct action contracts, evidence, limits, approvals and idempotency/reconciliation. Add only after text-response operation is reliable. A successful model proposal is never the receipt for a completed business action.
