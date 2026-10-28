import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, describe, it } from "node:test";
import { one } from "../../packages/storage/db.ts";
import { caseByThread, closeDb, createHarness, seedWorkspace, syncAndDrain, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

const COPY = "[Amazon.com] Sehr geehrte(r) Auwald Bio,\n\nHier ist eine Kopie der E-Mail, die du an Sevinc gesendet hast.\n\nBestellnummer 303-7978499-5468368:\n\nAnbei das Retourenlabel.";

describe("Amazon copies of our own messages", () => {
  it("are sorted out on arrival, without a draft", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    h.graph.addInbound({ from: "donotreply@amazon.com", subject: "Deine E-Mail an Sevinc", body: COPY, conversationId: "copy-1" });
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "copy-1");
    const row = (await one<{ category: string; category_reason: string }>(h.ctx.db, "SELECT category, category_reason FROM conversations WHERE id = $1", [conv.id]))!;
    assert.equal(row.category, "info");
    assert.equal(await one(h.ctx.db, "SELECT 1 FROM drafts WHERE conversation_id = $1", [conv.id]), null);
  });

  it("existing ones are moved by the migration, a person's choice stays", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    h.graph.addInbound({ from: "donotreply@amazon.com", subject: "Deine E-Mail an Sevinc", body: COPY, conversationId: "copy-2" });
    h.graph.addInbound({ from: "donotreply@amazon.com", subject: "Deine E-Mail an Ingrid", body: COPY.replace("Sevinc", "Ingrid"), conversationId: "copy-3" });
    await syncAndDrain(h, s);
    const auto = await caseByThread(h, s, "copy-2");
    const person = await caseByThread(h, s, "copy-3");
    // As before this update: filed as requests.
    await h.ctx.db.query("UPDATE conversations SET category = 'support', category_source = 'auto' WHERE id = $1", [auto.id]);
    await h.ctx.db.query("UPDATE conversations SET category = 'support', category_source = 'person' WHERE id = $1", [person.id]);
    await h.ctx.db.query(readFileSync(new URL("../../packages/storage/migrations/012_own_copies.sql", import.meta.url), "utf8"));
    assert.equal((await one<{ category: string }>(h.ctx.db, "SELECT category FROM conversations WHERE id = $1", [auto.id]))!.category, "info");
    assert.equal((await one<{ category: string }>(h.ctx.db, "SELECT category FROM conversations WHERE id = $1", [person.id]))!.category, "support");
  });
});
