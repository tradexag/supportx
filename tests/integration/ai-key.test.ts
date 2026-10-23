import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { RulesProvider } from "../../packages/ai/rules.ts";
import type { AiProvider } from "../../packages/core/contracts.ts";
import { checkWorkspaceAiKey, getSettings, setWorkspaceAiKey } from "../../packages/services/cases.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { one } from "../../packages/storage/db.ts";
import { caseByThread, closeDb, createHarness, loadDemoMails, seedWorkspace, syncAndDrain, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

const GOOD = "sk-ant-api03-" + "A".repeat(40) + "wxyz";

/** Claude stand-in: same proposals as the rule templates, but records the key it was built with. */
function fakeClaude(used: string[]) {
  return (apiKey: string): AiProvider => {
    used.push(apiKey);
    const rules = new RulesProvider();
    return { id: "claude", model: "fake-claude", promptVersion: "fake", propose: (input) => rules.propose(input) };
  };
}

describe("workspace Claude key", () => {
  it("checks, stores encrypted, uses it for drafts and never returns it", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const used: string[] = [];
    h.ctx.aiWithKey = fakeClaude(used);
    h.ctx.checkAiKey = async (key) => (key === GOOD ? { ok: true, detail: "ok" } : { ok: false, detail: "Schlüssel ungültig oder widerrufen." });

    await assert.rejects(setWorkspaceAiKey(h.ctx, s.owner, "not-a-key"), (e: ServiceError) => e.code === "INVALID");
    await assert.rejects(setWorkspaceAiKey(h.ctx, s.owner, "sk-ant-api03-" + "B".repeat(40)), (e: ServiceError) => e.code === "AI_KEY_REJECTED");
    await assert.rejects(setWorkspaceAiKey(h.ctx, s.agent, GOOD), (e: ServiceError) => e.code === "FORBIDDEN");
    await setWorkspaceAiKey(h.ctx, s.owner, `  ${GOOD}\n`);

    const settings = await getSettings(h.ctx, s.owner);
    assert.equal((settings.workspace as { has_ai_key: boolean }).has_ai_key, true);
    assert.equal((settings.workspace as { ai_key_hint: string }).ai_key_hint, "…wxyz");
    assert.doesNotMatch(JSON.stringify(settings), /sk-ant/);
    const raw = await one<{ n: number }>(h.ctx.db, "SELECT count(*)::int AS n FROM secrets WHERE position(convert_to('sk-ant', 'UTF8') in ciphertext) > 0");
    assert.equal(raw!.n, 0);
    assert.equal((await checkWorkspaceAiKey(h.ctx, s.owner)).ok, true);

    loadDemoMails(h.graph);
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "conv-amazon-wismo");
    const draft = await one<{ generated_by: string }>(h.ctx.db, "SELECT generated_by FROM drafts WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY created_at DESC LIMIT 1", [s.workspaceId, conv.id]);
    assert.equal(draft!.generated_by, "claude");
    assert.ok(used.length > 0 && used.every((k) => k === GOOD));
  });

  it("replacing removes the old secret, removing falls back to rule templates", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    h.ctx.checkAiKey = async () => ({ ok: true, detail: "ok" });
    await setWorkspaceAiKey(h.ctx, s.owner, GOOD);
    await setWorkspaceAiKey(h.ctx, s.owner, GOOD.replace("wxyz", "abcd"));
    const count = async () => (await one<{ n: number }>(h!.ctx.db, "SELECT count(*)::int AS n FROM secrets WHERE workspace_id = $1 AND purpose = 'anthropic_api_key'", [s.workspaceId]))!.n;
    assert.equal(await count(), 1);
    await setWorkspaceAiKey(h.ctx, s.owner, null);
    assert.equal(await count(), 0);
    assert.equal((await checkWorkspaceAiKey(h.ctx, s.owner)).ok, false);
    loadDemoMails(h.graph);
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "conv-amazon-wismo");
    const draft = await one<{ generated_by: string }>(h.ctx.db, "SELECT generated_by FROM drafts WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY created_at DESC LIMIT 1", [s.workspaceId, conv.id]);
    assert.equal(draft!.generated_by, "rules");
  });
});
