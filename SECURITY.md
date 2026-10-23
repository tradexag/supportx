# Security and operational boundaries

## Current state

Version 0.1.0 implements server-side sessions (scrypt passwords, HttpOnly SameSite=strict cookies, CSRF header on state-changing requests), workspace-scoped queries with composite foreign keys, AES-256-GCM encrypted connector secrets (key from `APP_ENCRYPTION_KEY`), endpoint allow-lists for Microsoft and weclapp hosts, a read-only weclapp adapter, versioned approvals and an outbox that never retries an uncertain send. These controls are covered by automated tests against test doubles; the deployment has not been penetration-tested or run against live accounts. Not yet implemented: attachment handling, retention jobs, rate limiting of the login endpoint, key rotation, SSO. Before public release, configure a private security-reporting channel; do not include credentials or customer information in public issues.

## Required implementation boundaries

- Derive workspace and account scope from authenticated server-side identity. Apply it to HTTP, workers, storage, attachments and MCP, including foreign-key checks.
- Store connector and AI-provider secrets on the server, encrypted at rest, with a separate deployment secret or managed key. Reference secrets by opaque handles. Do not place per-merchant credentials in browser storage, source code, logs or public examples.
- A new credential or successful connection test does not automatically enable sending. Verify capabilities and routes per connected account.
- Resolve recipients and seller identity from trusted connector metadata. AI text cannot choose them. Validate actual message provenance before accepting a marketplace relay route; a domain-looking string in an email body is not proof.
- Treat customer text, HTML, OCR and attachments as untrusted input. They cannot change instructions, permissions, tool destinations or action budgets. Sanitize displayed HTML, constrain attachment downloads and scan supported file types before processing.
- Use a transactional outbox and account-scoped idempotency records. Model an uncertain outbound result explicitly; do not blindly repeat a non-idempotent send after timeout.
- Keep drafts, approvals and dispatch versioned. A new inbound message, revised draft, changed reply route, revoked policy or changed order evidence invalidates an earlier approval where relevant.
- Use narrowly scoped, evidence-backed templates for initial unattended replies. Free-form proposals require review until separate evaluation and controls justify more autonomy.
- Keep financial and fulfillment-changing actions separate from text replies. Never state an action succeeded until the responsible provider has confirmed it.
- Minimize the case data sent to the model. Do not send complete mailbox archives, unrelated records, unnecessary addresses, full payment information or health attachments by default.
- Route medical advice requests or potentially sensitive health content outside ordinary logistics automation. A pharmacy marketplace connection does not establish permission to process every kind of customer data with every AI provider.
- Configure retention by source, purpose and applicable platform requirements; cover messages, attachments, caches, model traces and backups. Avoid a universal unlimited retention setting. Audit logs should record decisions and references without duplicating full message bodies.
- Validate webhook authentication, lifecycle renewal, cursor handling and replay protection. Respect provider-specific rate limits and synchronization permissions.

## Controlled live acceptance

Use designated test conversations or an approved test account. Confirm that replies use the correct seller identity, appear in the correct remote thread and are reconciled with provider results. Exercise one external manual reply, one duplicate event, one rate-limit response and one ambiguous send timeout before enabling any unattended rule. Keep a per-account pause switch and an operator-visible failure queue.
