import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { getCase } from "../../packages/services/cases.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { polishDraft, requestRedraft } from "../../packages/services/replies.ts";
import { drainJobs } from "../../packages/services/worker.ts";
import { enqueue } from "../../packages/services/jobs.ts";
import { many } from "../../packages/storage/db.ts";
import { caseByThread, closeDb, createHarness, currentDraft, loadDemoMails, seedWorkspace, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

describe("decision before the reply", () => {
  it("writes no reply on its own, only after a person decided, and keeps the decision", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    loadDemoMails(h.graph);
    await enqueue(h.ctx.db, { workspaceId: s.workspaceId, type: "mail.sync", payload: { connectionId: s.connectionId }, dedupeKey: `mail.sync:${s.connectionId}` });
    await drainJobs(h.ctx, { maxJobs: 500 });
    assert.equal((await many(h.ctx.db, "SELECT id FROM drafts WHERE workspace_id = $1", [s.workspaceId])).length, 0, "no draft (and no AI cost) without a click");

    const conv = await caseByThread(h, s, "conv-shopify-wrong");
    await assert.rejects(requestRedraft(h.ctx, s.agent, conv.id, "gift" as never), (e: ServiceError) => e.code === "INVALID");
    await requestRedraft(h.ctx, s.agent, conv.id, "customer_right");
    await drainJobs(h.ctx);
    const draft = (await currentDraft(h, s, conv.id))!;
    assert.match(draft.body, /Sie haben recht/);
    const data = await getCase(h.ctx, s.agent, conv.id);
    assert.equal((data.drafts[0] as { decision: string }).decision, "customer_right");
    assert.equal(data.writer, "rules");

    // The demo order title says green, the linked weclapp article red: the case shows it.
    assert.ok(data.titleHints.some((t) => t.includes("Kissenbezug 40x40, rot")), JSON.stringify(data.titleHints));

    await requestRedraft(h.ctx, s.agent, conv.id, "customer_wrong");
    await drainJobs(h.ctx);
    assert.match((await currentDraft(h, s, conv.id))!.body, /sorgfältig geprüft/);
  });

  it("rewrites the person's own text only with a language model and saves it as an edit", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    loadDemoMails(h.graph);
    await enqueue(h.ctx.db, { workspaceId: s.workspaceId, type: "mail.sync", payload: { connectionId: s.connectionId }, dedupeKey: `mail.sync:${s.connectionId}` });
    await drainJobs(h.ctx, { maxJobs: 500 });
    const conv = await caseByThread(h, s, "conv-shopify-wrong");
    await requestRedraft(h.ctx, s.agent, conv.id, "ask_customer");
    await drainJobs(h.ctx);
    const draft = (await currentDraft(h, s, conv.id))!;
    await assert.rejects(polishDraft(h.ctx, s.agent, draft.id, { body: "schick foto", expectedVersion: draft.version }), (e: ServiceError) => e.code === "NO_AI");

    const seen: string[] = [];
    h.ctx.ai = { ...h.ctx.ai, id: "claude", model: "test", promptVersion: "t", propose: h.ctx.ai.propose.bind(h.ctx.ai), polish: async (input) => { seen.push(input.text); return `Guten Tag,\n\nkönnten Sie uns bitte ein Foto senden?\n\nViele Grüße`; } };
    await assert.rejects(polishDraft(h.ctx, s.viewer, draft.id, { body: "x", expectedVersion: draft.version }), (e: ServiceError) => e.code === "FORBIDDEN");
    const result = await polishDraft(h.ctx, s.agent, draft.id, { body: "schick foto", expectedVersion: draft.version });
    assert.deepEqual(seen, ["schick foto"]);
    assert.match(result.body, /könnten Sie uns bitte ein Foto senden/);
    assert.equal(result.version, draft.version + 1);
    const saved = (await currentDraft(h, s, conv.id))!;
    assert.equal(saved.status, "edited");
    assert.equal(saved.body, result.body);
  });
});
