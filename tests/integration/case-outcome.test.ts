import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { exportCasesCsv, getCase, setOutcome } from "../../packages/services/cases.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { closeDb, createHarness, seedWorkspace, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

describe("case outcome and export", () => {
  it("records what was done, exports it for owners only, and keeps other workspaces out", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const other = await seedWorkspace(h, "Anderer Händler");
    const conv = async (ws: typeof s, subject: string, body: string) => {
      const row = await h!.ctx.db.query<{ id: string }>(
        "INSERT INTO conversations (workspace_id, connection_id, external_thread_key, source_platform, subject, customer_address, last_message_at) VALUES ($1, $2, $3, 'amazon', $4, 'kunde@example.invalid', now()) RETURNING id",
        [ws.workspaceId, ws.connectionId, `t-${subject}`, subject],
      );
      const id = row.rows[0]!.id;
      await h!.ctx.db.query(
        "INSERT INTO messages (workspace_id, conversation_id, connection_id, external_message_id, direction, kind, from_address, subject, body_text, received_at) VALUES ($1, $2, $3, $4, 'inbound', 'customer', 'kunde@example.invalid', $5, $6, now())",
        [ws.workspaceId, id, ws.connectionId, `m-${subject}`, subject, body],
      );
      return id;
    };
    const mine = await conv(s, "Falsche Dose", "Nachricht:\n\nFalsche Dose erhalten; bitte =Ersatz\n\nNachricht anzeigen <https://x.invalid>");
    await conv(other, "Fremd", "geheim");

    const earlier = await conv(s, "Erste Frage", "Wo bleibt meine Dose?");
    const related = (await getCase(h.ctx, s.agent, mine)).relatedMessages as Array<{ conversation_id: string; body_text: string }>;
    assert.deepEqual(related.map((m) => m.conversation_id), [earlier], "earlier case of the same customer shows up in the history");
    assert.ok(!related.some((m) => m.body_text === "geheim"), "never messages from another workspace");

    await setOutcome(h.ctx, s.agent, mine, { outcome: "replacement", note: "neue Dose verschickt" });
    const c = (await getCase(h.ctx, s.agent, mine)).conversation as { outcome: string; outcome_note: string; outcome_at: string };
    assert.equal(c.outcome, "replacement");
    assert.equal(c.outcome_note, "neue Dose verschickt");
    assert.ok(c.outcome_at);
    await assert.rejects(setOutcome(h.ctx, s.agent, mine, { outcome: "gift" }), (e: ServiceError) => e.code === "INVALID");
    await assert.rejects(setOutcome(h.ctx, other.owner, mine, { outcome: "none" }), (e: ServiceError) => e.code === "NOT_FOUND", "another workspace cannot touch the case");

    await assert.rejects(exportCasesCsv(h.ctx, s.agent), (e: ServiceError) => e.code === "FORBIDDEN");
    const csv = await exportCasesCsv(h.ctx, s.owner);
    assert.ok(csv.startsWith("﻿Fall;Eingang;Marktplatz"));
    assert.match(csv, /"Falsche Dose erhalten; bitte =Ersatz"/, "customer words only, quoted because of the semicolon");
    assert.match(csv, /replacement;neue Dose verschickt/);
    assert.ok(!csv.includes("geheim") && !csv.includes("https://x.invalid"));

    await setOutcome(h.ctx, s.agent, mine, { outcome: null });
    const cleared = (await getCase(h.ctx, s.agent, mine)).conversation as { outcome: string | null; outcome_at: string | null };
    assert.equal(cleared.outcome, null);
    assert.equal(cleared.outcome_at, null);
  });
});
