import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { getMessageAttachment, listMessageAttachments } from "../../packages/services/attachments.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { one } from "../../packages/storage/db.ts";
import { caseByThread, closeDb, createHarness, seedWorkspace, syncAndDrain, type Harness } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("customer attachments", () => {
  it("lists the customer's files live from the mailbox, serves them, and keeps other workspaces out", async () => {
    h = await createHarness();
    const s = await seedWorkspace(h);
    const other = await seedWorkspace(h, "Anderer Händler");
    h.graph.addInbound({
      from: "kunde@example.invalid", subject: "Falsche Dose", body: "Foto anbei", conversationId: "att",
      attachments: [
        { id: "a-photo", name: "dose.png", contentType: "image/png", contentBytes: PNG.toString("base64") },
        { id: "a-label", name: "etikett.pdf", contentType: "application/pdf", contentBytes: Buffer.from("%PDF-1.4").toString("base64") },
        { id: "a-logo", name: "logo.png", contentType: "image/png", contentBytes: PNG.toString("base64"), isInline: true },
      ],
    });
    await syncAndDrain(h, s);
    const conv = await caseByThread(h, s, "att");
    const msg = (await one<{ id: string; has_attachments: boolean }>(h.ctx.db, "SELECT id, has_attachments FROM messages WHERE conversation_id = $1", [conv.id]))!;
    assert.equal(msg.has_attachments, true);

    const list = await listMessageAttachments(h.ctx, s.viewer, msg.id);
    assert.deepEqual(list.map((a) => [a.name, a.inline]), [["dose.png", true], ["etikett.pdf", false]], "inline template images are left out");
    const photo = await getMessageAttachment(h.ctx, s.agent, msg.id, "a-photo");
    assert.ok(photo.data.equals(PNG));
    assert.equal(photo.inline, true);
    assert.equal((await getMessageAttachment(h.ctx, s.agent, msg.id, "a-label")).inline, false, "a PDF is only offered as a download");

    const notFound = (e: ServiceError) => e.code === "NOT_FOUND";
    await assert.rejects(getMessageAttachment(h.ctx, s.agent, msg.id, "a-unknown"), notFound);
    await assert.rejects(listMessageAttachments(h.ctx, other.owner, msg.id), notFound, "another workspace cannot read the files");
    await assert.rejects(getMessageAttachment(h.ctx, other.owner, msg.id, "a-photo"), notFound);
  });
});
