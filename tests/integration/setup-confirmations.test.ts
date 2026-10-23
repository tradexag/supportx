import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { getSettings, setSetupConfirmation } from "../../packages/services/cases.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { closeDb, createHarness, seedWorkspace, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

type Confirmations = Record<string, { at: string; by: string | null }>;
const confirmations = async (s: Awaited<ReturnType<typeof seedWorkspace>>) =>
  ((await getSettings(h!.ctx, s.owner)).workspace as { setup_confirmations: Confirmations }).setup_confirmations;

describe("setup confirmations", () => {
  it("only owners tick off external steps, only for mail marketplaces, and can undo it", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    assert.deepEqual(await confirmations(s), {});

    await assert.rejects(setSetupConfirmation(h.ctx, s.agent, { platform: "amazon", done: true }), (e: ServiceError) => e.code === "FORBIDDEN");
    await assert.rejects(setSetupConfirmation(h.ctx, s.owner, { platform: "kaufland", done: true }), (e: ServiceError) => e.code === "INVALID");

    await setSetupConfirmation(h.ctx, s.owner, { platform: "amazon", done: true });
    await setSetupConfirmation(h.ctx, s.owner, { platform: "shopify", done: true });
    const ticked = await confirmations(s);
    assert.deepEqual(Object.keys(ticked).sort(), ["amazon", "shopify"]);
    assert.ok(ticked.amazon!.at);

    await setSetupConfirmation(h.ctx, s.owner, { platform: "amazon", done: false });
    assert.deepEqual(Object.keys(await confirmations(s)), ["shopify"]);
  });
});
