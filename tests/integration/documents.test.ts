import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { getCase } from "../../packages/services/cases.ts";
import { createKauflandConnection, setSendEnabled, verifyReplyRoute } from "../../packages/services/connections.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { deleteDocument, getDocument, listDocuments, setDraftDocuments, uploadDocument } from "../../packages/services/documents.ts";
import { enqueue } from "../../packages/services/jobs.ts";
import { approveDraft, dispatchOutbox, queueReply } from "../../packages/services/replies.ts";
import { one } from "../../packages/storage/db.ts";
import { startFakeKaufland } from "../../packages/testing/fake-marketplaces.ts";
import { caseByThread, closeDb, createHarness, currentDraft, drainWithDrafts, loadDemoMails, seedWorkspace, syncAndDrain, type Harness } from "./harness.ts";

let h: Harness | null = null;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await h?.close();
  h = null;
  for (const c of closers.splice(0)) await c();
});
after(closeDb);

const PDF = Buffer.from("%PDF-1.4\n% Retourenanleitung\n%%EOF");
const rejectsWith = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: ServiceError) => e.code === code);

describe("documents for replies", () => {
  it("accepts only PDFs up to the limit, owner only, and keeps workspaces apart", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const other = await seedWorkspace(h, "Anderer Händler");
    await rejectsWith(uploadDocument(h.ctx, s.agent, { name: "a.pdf", data: PDF }), "FORBIDDEN");
    await rejectsWith(uploadDocument(h.ctx, s.owner, { name: "bild.png", data: Buffer.from("\x89PNG....") }), "NOT_PDF");
    await rejectsWith(uploadDocument(h.ctx, s.owner, { name: "gross.pdf", data: Buffer.concat([PDF, Buffer.alloc(3 * 1024 * 1024)]) }), "TOO_LARGE");
    const doc = await uploadDocument(h.ctx, s.owner, { name: "../Retouren Anleitung", data: PDF });
    assert.equal(doc.name, "Retouren Anleitung.pdf", "path parts are dropped and .pdf is added");
    assert.deepEqual((await listDocuments(h.ctx, s.viewer)).map((d) => d.id), [doc.id]);
    assert.equal((await listDocuments(h.ctx, other.owner)).length, 0);
    await rejectsWith(getDocument(h.ctx, other.owner, doc.id), "NOT_FOUND");
    await rejectsWith(deleteDocument(h.ctx, other.owner, doc.id), "NOT_FOUND");
    assert.ok((await getDocument(h.ctx, s.agent, doc.id)).data.equals(PDF));
  });

  it("sends the chosen PDF with the mail reply; choosing files voids an earlier approval", async () => {
    h = await createHarness({ sendMode: "enabled" });
    const s = await seedWorkspace(h);
    const other = await seedWorkspace(h, "Anderer Händler");
    loadDemoMails(h.graph);
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "conv-amazon-wismo");
    const draft = (await currentDraft(h, s, conv.id))!;
    assert.equal((await getCase(h.ctx, s.agent, conv.id)).replyFiles.supported, true, "a mail reply can carry the PDF");
    const early = await approveDraft(h.ctx, s.agent, draft.id, { expectedVersion: draft.version, acknowledgeWarnings: true });
    const doc = await uploadDocument(h.ctx, s.owner, { name: "Retouren.pdf", data: PDF });
    const foreign = await uploadDocument(h.ctx, other.owner, { name: "Fremd.pdf", data: PDF });
    await rejectsWith(setDraftDocuments(h.ctx, s.agent, draft.id, { documentIds: [foreign.id], expectedVersion: draft.version }), "NOT_FOUND");
    await rejectsWith(setDraftDocuments(h.ctx, s.viewer, draft.id, { documentIds: [doc.id], expectedVersion: draft.version }), "FORBIDDEN");
    const { version } = await setDraftDocuments(h.ctx, s.agent, draft.id, { documentIds: [doc.id], expectedVersion: draft.version });
    assert.equal(version, draft.version + 1);

    await verifyReplyRoute(h.ctx, s.owner, s.connectionId, { sourcePlatform: "amazon", evidenceNote: "Testantwort an Testbestellung am 21.10. kam im Käuferpostfach an" });
    await setSendEnabled(h.ctx, s.owner, s.connectionId, true);
    await rejectsWith(queueReply(h.ctx, s.agent, early), "APPROVAL_INVALID");

    const approval = await approveDraft(h.ctx, s.agent, draft.id, { expectedVersion: version, acknowledgeWarnings: true });
    const outboxId = await queueReply(h.ctx, s.agent, approval);
    // Removing it from the list later does not change what was approved.
    await deleteDocument(h.ctx, s.owner, doc.id);
    assert.equal(await dispatchOutbox(h.ctx, s.workspaceId, outboxId), "provider_accepted");
    const sent = h.graph.replies.at(-1)!;
    assert.deepEqual(sent.attachments.map((a) => [a.name, a.contentType]), [["Retouren.pdf", "application/pdf"]]);
    assert.ok(Buffer.from(sent.attachments[0]!.contentBytes, "base64").equals(PDF));
  });

  it("attaches to Kaufland ticket messages", async () => {
    h = await createHarness({ sendMode: "enabled" });
    const s = await seedWorkspace(h);
    const KFL = { clientKey: "client-key-test", secretKey: "secret-key-test" };
    const fake = await startFakeKaufland(KFL);
    closers.push(() => fake.close());
    fake.addTicket({ id_ticket: "T5", id_order: "M3KX7Q5", buyer: { firstname: "Erika", lastname: "Muster" } });
    fake.addMessage("T5", "buyer", "Wie schicke ich das zurück?", new Date(Date.now() - 600_000));
    const id = await createKauflandConnection(h.ctx, s.owner, { displayName: "Kaufland", ...KFL, baseUrl: fake.baseUrl });
    await enqueue(h.ctx.db, { workspaceId: s.workspaceId, type: "mail.sync", payload: { connectionId: id }, dedupeKey: `mail.sync:${id}` });
    await drainWithDrafts(h, 200);
    const conv = (await one<{ id: string }>(h.ctx.db, "SELECT id FROM conversations WHERE connection_id = $1", [id]))!;
    const draft = (await currentDraft(h, s, conv.id))!;
    assert.equal((await getCase(h.ctx, s.agent, conv.id)).replyFiles.supported, true);
    const doc = await uploadDocument(h.ctx, s.owner, { name: "Retouren.pdf", data: PDF });
    const { version } = await setDraftDocuments(h.ctx, s.agent, draft.id, { documentIds: [doc.id], expectedVersion: draft.version });
    await verifyReplyRoute(h.ctx, s.owner, id, { sourcePlatform: "kaufland", evidenceNote: "Testantwort im Ticket sichtbar, 28.10." });
    await setSendEnabled(h.ctx, s.owner, id, true);
    const outboxId = await queueReply(h.ctx, s.agent, await approveDraft(h.ctx, s.agent, draft.id, { expectedVersion: version, acknowledgeWarnings: true }));
    assert.equal(await dispatchOutbox(h.ctx, s.workspaceId, outboxId), "provider_accepted");
    const file = fake.posted.at(-1)!.files[0]!;
    assert.equal(file.filename, "Retouren.pdf");
    assert.equal(file.mime_type, "application/pdf");
    assert.equal(file.data, `data:application/pdf;base64,${PDF.toString("base64")}`);
  });
});
