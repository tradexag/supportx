import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { createGraphConnection, deleteConnection, replaceConnectionSecret, setConnectionPaused, setSendEnabled, verifyReplyRoute } from "../../packages/services/connections.ts";
import { approveDraft, queueReply } from "../../packages/services/replies.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { many, one } from "../../packages/storage/db.ts";
import { drainJobs, scheduleTick } from "../../packages/services/worker.ts";
import { caseCounts, listCases, setCaseCategory } from "../../packages/services/cases.ts";
import { recategorizeAutoCases } from "../../packages/services/ingestion.ts";
import { caseByThread, closeDb, createHarness, currentDraft, drainWithDrafts, loadDemoMails, seedWorkspace, syncAndDrain, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

const rejectsWith = async (promise: Promise<unknown>, code: string, text?: RegExp) =>
  assert.rejects(promise, (error: ServiceError) => {
    assert.equal(error.code, code, error.message);
    if (text) assert.match(error.message, text);
    return true;
  });

const SECRET_ID = "a17ea2e6-2fe5-4fa3-88b3-15c10fc71bcc";

describe("Microsoft connection management", () => {
  it("rejects a pasted secret ID and a second active connection for the same mailbox", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const base = { displayName: "Zweit", tenantId: "00000000-0000-0000-0000-000000000000", clientId: "client", mailbox: h.graph.mailbox, graphBaseUrl: h.graph.graphBaseUrl, authorityHost: h.graph.authorityHost };
    await rejectsWith(createGraphConnection(h.ctx, s.owner, { ...base, clientSecret: SECRET_ID }), "INVALID", /Geheime ID/);
    await rejectsWith(createGraphConnection(h.ctx, s.owner, { ...base, clientSecret: "Abc8Q~valid-looking" }), "DUPLICATE");
    await setConnectionPaused(h.ctx, s.owner, s.connectionId, true);
    await createGraphConnection(h.ctx, s.owner, { ...base, clientSecret: "  Abc8Q~valid-looking \n" });
    const row = await one<{ config: { secretHint: { prefix: string; length: number } } }>(h.ctx.db, "SELECT config FROM channel_connections WHERE workspace_id = $1 AND display_name = 'Zweit'", [s.workspaceId]);
    assert.deepEqual(row!.config.secretHint, { prefix: "Abc", length: 19 });
  });

  it("replaces the secret, removes the old one and clears the error", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const before = await one<{ secret_id: string }>(h.ctx.db, "SELECT secret_id FROM channel_connections WHERE id = $1", [s.connectionId]);
    await h.ctx.db.query("UPDATE channel_connections SET health = 'error', last_error = 'x', last_error_at = now() WHERE id = $1", [s.connectionId]);
    await rejectsWith(replaceConnectionSecret(h.ctx, s.owner, s.connectionId, SECRET_ID), "INVALID");
    await rejectsWith(replaceConnectionSecret(h.ctx, s.agent, s.connectionId, "Neu~geheim"), "FORBIDDEN");
    await replaceConnectionSecret(h.ctx, s.owner, s.connectionId, "Neu~geheim");
    const after_ = await one<{ secret_id: string; health: string; last_error: string | null }>(h.ctx.db, "SELECT secret_id, health, last_error FROM channel_connections WHERE id = $1", [s.connectionId]);
    assert.notEqual(after_!.secret_id, before!.secret_id);
    assert.equal(after_!.health, "unknown");
    assert.equal(after_!.last_error, null);
    assert.equal(await one(h.ctx.db, "SELECT 1 FROM secrets WHERE id = $1", [before!.secret_id]), null);
    assert.equal(await h.ctx.secrets.read(h.ctx.db, s.workspaceId, after_!.secret_id), "Neu~geheim");
  });

  it("deletes a duplicate connection with its cases but keeps other workspaces' data", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const other = await seedWorkspace(h, "Anderer Händler");
    loadDemoMails(h.graph);
    await syncAndDrain(h, s);
    await syncAndDrain(h, other);
    const count = async (ws: string) => (await many(h!.ctx.db, "SELECT 1 FROM conversations WHERE workspace_id = $1", [ws])).length;
    const otherBefore = await count(other.workspaceId);
    assert.ok((await count(s.workspaceId)) > 0);
    await rejectsWith(deleteConnection(h.ctx, s.agent, s.connectionId), "FORBIDDEN");
    await rejectsWith(deleteConnection(h.ctx, s.owner, other.connectionId), "NOT_FOUND");
    const result = await deleteConnection(h.ctx, s.owner, s.connectionId);
    assert.ok(result.deletedCases > 0);
    assert.equal(await count(s.workspaceId), 0);
    assert.equal(await one(h.ctx.db, "SELECT 1 FROM channel_connections WHERE id = $1", [s.connectionId]), null);
    assert.equal(await count(other.workspaceId), otherBefore);
  });

  it("refuses to delete a connection that already sent something", async () => {
    h = await createHarness({ sendMode: "enabled" });
    const s = await seedWorkspace(h);
    loadDemoMails(h.graph);
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "conv-amazon-wismo");
    const draft = (await currentDraft(h, s, conv.id))!;
    const approvalId = await approveDraft(h.ctx, s.agent, draft.id, { expectedVersion: draft.version, acknowledgeWarnings: true });
    await verifyReplyRoute(h.ctx, s.owner, s.connectionId, { sourcePlatform: "amazon", evidenceNote: "Testantwort an Testbestellung kam im Käuferpostfach an" });
    await setSendEnabled(h.ctx, s.owner, s.connectionId, true);
    await queueReply(h.ctx, s.agent, approvalId);
    await rejectsWith(deleteConnection(h.ctx, s.owner, s.connectionId), "IN_USE");
    assert.ok(await one(h.ctx.db, "SELECT 1 FROM channel_connections WHERE id = $1", [s.connectionId]));
  });

  it("waits before retrying a failing mailbox", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    await h.ctx.db.query("UPDATE channel_connections SET health = 'error', last_error = 'AADSTS7000215', last_error_at = now(), last_sync_at = NULL WHERE id = $1", [s.connectionId]);
    await h.ctx.db.query("DELETE FROM jobs WHERE workspace_id = $1", [s.workspaceId]);
    await scheduleTick(h.ctx);
    assert.equal((await many(h.ctx.db, "SELECT 1 FROM jobs WHERE workspace_id = $1 AND type = 'mail.sync'", [s.workspaceId])).length, 0);
    await h.ctx.db.query("UPDATE channel_connections SET last_error_at = now() - interval '20 minutes' WHERE id = $1", [s.connectionId]);
    await scheduleTick(h.ctx);
    assert.equal((await many(h.ctx.db, "SELECT 1 FROM jobs WHERE workspace_id = $1 AND type = 'mail.sync'", [s.workspaceId])).length, 1);
  });
});

describe("advertising detection", () => {
  it("files a promotion without order matching or draft, and a person can turn it into a request for the whole sender", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    h.graph.addInbound({ from: "marketplace@partner-shop.example.invalid", subject: "Singles Day 2026 – Voucher-Aktionen", body: "Liebe Marketplace-Partner,\njetzt für die Voucher-Aktionen anmelden.", conversationId: "promo-1" });
    h.graph.addInbound({ from: "kunde@shop.example.invalid", subject: "Bestellung #1001", body: "Wo ist sie?", conversationId: "kunde-1" });
    await syncAndDrain(h, s);
    const promo = await caseByThread(h, s, "promo-1");
    const row = await one<{ category: string; order_match_status: string }>(h.ctx.db, "SELECT category, order_match_status FROM conversations WHERE id = $1", [promo.id]);
    assert.equal(row!.category, "info");
    assert.equal(row!.order_match_status, "pending");
    assert.equal(await currentDraft(h, s, promo.id), null);
    assert.equal((await one<{ category: string }>(h.ctx.db, "SELECT category FROM conversations WHERE id = $1", [(await caseByThread(h, s, "kunde-1")).id]))!.category, "support");

    const tabs = await caseCounts(h.ctx, s.agent);
    assert.equal(tabs!.info, 1);
    assert.ok(!(await listCases(h.ctx, s.agent, "open")).some((c) => (c as { id: string }).id === promo.id));

    await rejectsWith(setCaseCategory(h.ctx, s.viewer, promo.id, { category: "support" }), "FORBIDDEN");
    await setCaseCategory(h.ctx, s.agent, promo.id, { category: "support", remember: "domain" });
    await drainWithDrafts(h, 50);
    assert.ok(await currentDraft(h, s, promo.id), "draft after turning it into a request");

    h.graph.addInbound({ from: "news@partner-shop.example.invalid", subject: "Webinar", body: "Liebe Partner, Webinar am Montag.", conversationId: "promo-2" });
    await syncAndDrain(h, s);
    assert.equal((await one<{ category: string; category_source: string }>(h.ctx.db, "SELECT category, category_source FROM conversations WHERE id = $1", [(await caseByThread(h, s, "promo-2")).id]))!.category_source, "rule");
  });

  it("re-sorts existing automatic cases after the update and retires their drafts", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    h.graph.addInbound({ from: "marketplace@partner-shop.example.invalid", subject: "Top brands in demand on our marketplace", body: "Dear partner, these brands sell well.", conversationId: "old-promo" });
    await syncAndDrain(h, s);
    const id = (await caseByThread(h, s, "old-promo")).id;
    // Simulate data from before the update: filed as a request with a draft.
    await setCaseCategory(h.ctx, s.agent, id, { category: "support" });
    await h.ctx.db.query("UPDATE conversations SET category_source = 'auto' WHERE id = $1", [id]);
    await drainWithDrafts(h, 50);
    assert.ok(await currentDraft(h, s, id));
    const result = await recategorizeAutoCases(h.ctx.db);
    assert.ok(result.info >= 1);
    assert.equal((await one<{ category: string }>(h.ctx.db, "SELECT category FROM conversations WHERE id = $1", [id]))!.category, "info");
    assert.equal(await currentDraft(h, s, id), null);
  });
});
