import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { mergeSplitFollowUps } from "../../packages/services/ingestion.ts";
import { many, one } from "../../packages/storage/db.ts";
import { caseByThread, closeDb, createHarness, seedWorkspace, syncAndDrain, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

const BUYER = "17h2lrrxxwtqzl0@marketplace.amazon.de";
const SUBJECT = "Entspricht nicht dem was ich bestellt habe (Bestellung: 305-9277799-7269158)";

describe("customer follow-ups", () => {
  it("join the open case of the same customer and order instead of opening a new one", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    h.graph.addInbound({ from: BUYER, subject: SUBJECT, body: "Ich habe die braune Dose bekommen.", conversationId: "t-1" });
    await syncAndDrain(h, s);
    h.graph.addInbound({ from: BUYER, subject: SUBJECT, body: "Ja, mit der Lösung bin ich einverstanden.", conversationId: "t-2" });
    h.graph.addInbound({ from: "andere@marketplace.amazon.de", subject: SUBJECT, body: "Andere Person, gleiche Nummer.", conversationId: "t-3" });
    await syncAndDrain(h, s);
    const first = await caseByThread(h, s, "t-1");
    assert.equal((await caseByThread(h, s, "t-2")).id, first.id);
    assert.notEqual((await caseByThread(h, s, "t-3")).id, first.id, "another customer keeps their own case");
    const msgs = await many<{ body_text: string }>(h.ctx.db, "SELECT body_text FROM messages WHERE conversation_id = $1 ORDER BY received_at", [first.id]);
    assert.equal(msgs.length, 2);
    const latest = await one<{ body_text: string }>(h.ctx.db, "SELECT body_text FROM messages WHERE id = $1", [first.latest_inbound_message_id]);
    assert.match(latest!.body_text, /einverstanden/);
  });

  it("merges cases that were split before, without touching sent ones", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    h.graph.addInbound({ from: BUYER, subject: SUBJECT, body: "Ich habe die braune Dose bekommen.", conversationId: "m-1" });
    await syncAndDrain(h, s);
    h.graph.addInbound({ from: BUYER, subject: SUBJECT, body: "Ja, mit der Lösung bin ich einverstanden.", conversationId: "m-2" });
    await syncAndDrain(h, s);
    // As before this update: the follow-up had become its own case.
    const first = await caseByThread(h, s, "m-1");
    const later = (await one<{ id: string }>(h.ctx.db, "SELECT id FROM conversations WHERE workspace_id = $1 AND id <> $2", [s.workspaceId, first.id]));
    if (!later) {
      await h.ctx.db.query("DELETE FROM conversation_threads WHERE workspace_id = $1", [s.workspaceId]);
      const moved = await one<{ id: string }>(
        h.ctx.db,
        `INSERT INTO conversations (workspace_id, connection_id, external_thread_key, source_platform, subject, customer_address, order_references, last_message_at, created_at)
         SELECT workspace_id, connection_id, 'm-2', source_platform, subject, customer_address, order_references, now(), now() FROM conversations WHERE id = $1 RETURNING id`,
        [first.id],
      );
      await h.ctx.db.query("UPDATE messages SET conversation_id = $2 WHERE conversation_id = $1 AND body_text LIKE '%einverstanden%'", [first.id, moved!.id]);
    }
    assert.equal((await many(h.ctx.db, "SELECT 1 FROM conversations WHERE workspace_id = $1", [s.workspaceId])).length, 2);
    assert.equal(await mergeSplitFollowUps(h.ctx.db), 1);
    assert.equal((await many(h.ctx.db, "SELECT 1 FROM conversations WHERE workspace_id = $1", [s.workspaceId])).length, 1);
    assert.equal((await caseByThread(h, s, "m-2")).id, first.id, "later mails of that thread keep joining the case");
    assert.equal((await many(h.ctx.db, "SELECT 1 FROM messages WHERE conversation_id = $1", [first.id])).length, 2);
    assert.equal(await mergeSplitFollowUps(h.ctx.db), 0, "idempotent");
  });
});
