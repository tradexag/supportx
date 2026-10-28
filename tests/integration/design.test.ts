import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { previewDesign, resetDesign, saveDesign, workspaceTheme } from "../../packages/services/design.ts";
import { closeDb, createHarness, seedWorkspace, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

describe("workspace design", () => {
  it("only the owner previews and saves, the look stays in its workspace, reset restores the default", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const other = await seedWorkspace(h, "Anderer Händler");
    const reading = previewDesign(s.owner, "Hintergrund: #ffffff\nAkzent: #6d33d6");
    assert.equal(reading.theme.colors.accent, "#6d33d6");
    assert.throws(() => previewDesign(s.agent, "Akzent: #6d33d6"), (e: { status?: number }) => e.status === 403);
    await assert.rejects(saveDesign(h.ctx, s.agent, reading.theme), (e: { status?: number }) => e.status === 403);
    await assert.rejects(saveDesign(h.ctx, s.owner, { colors: { text: "red" }, fonts: {} }), (e: { status?: number }) => e.status === 400);

    await saveDesign(h.ctx, s.owner, reading.theme);
    assert.equal((await workspaceTheme(h.ctx, s.viewer))?.colors.accent, "#6d33d6", "everyone in the workspace gets the look");
    assert.equal(await workspaceTheme(h.ctx, other.owner), null, "another workspace keeps its own look");

    await resetDesign(h.ctx, s.owner);
    assert.equal(await workspaceTheme(h.ctx, s.owner), null);
  });
});
