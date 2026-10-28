import { createHash } from "node:crypto";
import { many, one, withTx } from "../storage/db.ts";
import { audit } from "./audit.ts";
import type { ChannelKind } from "./connections.ts";
import { actorId, requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";

/** Per PDF and per reply: Graph takes attachments inline only up to about 3 MB per request. */
export const MAX_DOCUMENT_BYTES = 3 * 1024 * 1024;
export const MAX_REPLY_DOCUMENTS = 3;
const MAX_DOCUMENTS = 50;
const UUID = /^[0-9a-f-]{36}$/i;

/** Whether a reply over this connection can carry files, and what to do otherwise. */
export const REPLY_FILES: Record<ChannelKind, { supported: boolean; note: string }> = {
  // Amazon, DocMorris, Shopify and other mail answers go out as a mail reply with the PDF attached.
  microsoft_graph: { supported: true, note: "Die PDF geht als Anhang der Antwortmail raus. Amazon leitet PDF-Anhänge an den Käufer weiter." },
  kaufland_tickets: { supported: true, note: "Die PDF wird an die Ticket-Nachricht bei Kaufland angehängt." },
  mirakl_inbox: { supported: true, note: "Die PDF wird an die Nachricht bei Shop Apotheke angehängt." },
  ebay_messages: { supported: false, note: "eBay nimmt in Nachrichten keine hochgeladenen Dateien an. Schreib die wichtigsten Punkte in die Antwort oder setze einen Link (unter „Antworten“ als freigegebener Link-Anfang)." },
};

export interface DocumentInfo {
  id: string;
  name: string;
  size: number;
  created_at: Date;
}

function cleanName(raw: string): string {
  const base = raw.replace(/^.*[\\/]/, "").replace(/[\u0000-\u001f"<>|*?:]/g, "").trim().slice(0, 120);
  const name = base || "Dokument";
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

export async function listDocuments(ctx: AppContext, actor: Actor): Promise<DocumentInfo[]> {
  return many<DocumentInfo>(ctx.db, "SELECT id, name, size, created_at FROM documents WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY name", [actor.workspaceId]);
}

/** Only real PDFs up to the limit; the content is never interpreted. */
export async function uploadDocument(ctx: AppContext, actor: Actor, input: { name: string; data: Buffer }): Promise<DocumentInfo> {
  requireRole(actor, ["owner"]);
  if (input.data.length === 0) throw new ServiceError(400, "INVALID", "Die Datei ist leer.");
  if (input.data.length > MAX_DOCUMENT_BYTES) throw new ServiceError(413, "TOO_LARGE", "Die PDF ist zu groß (höchstens 3 MB). Bitte verkleinern, z. B. beim Export „für Web“ wählen.");
  if (input.data.subarray(0, 5).toString("latin1") !== "%PDF-") throw new ServiceError(400, "NOT_PDF", "Das ist keine PDF-Datei. Bitte nur PDFs hochladen.");
  const count = await one<{ n: number }>(ctx.db, "SELECT count(*)::int AS n FROM documents WHERE workspace_id = $1 AND deleted_at IS NULL", [actor.workspaceId]);
  if ((count?.n ?? 0) >= MAX_DOCUMENTS) throw new ServiceError(409, "TOO_MANY", `Es sind schon ${MAX_DOCUMENTS} Dokumente hinterlegt. Bitte erst ein altes entfernen.`);
  const row = await one<DocumentInfo>(
    ctx.db,
    "INSERT INTO documents (workspace_id, name, size, sha256, data, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, size, created_at",
    [actor.workspaceId, cleanName(input.name), input.data.length, createHash("sha256").update(input.data).digest("hex"), input.data, actorId(actor)],
  );
  await audit(ctx.db, actor, "document.uploaded", "document", row!.id, { name: row!.name, size: row!.size });
  return row!;
}

export async function deleteDocument(ctx: AppContext, actor: Actor, id: string): Promise<void> {
  requireRole(actor, ["owner"]);
  if (!UUID.test(id)) throw new ServiceError(404, "NOT_FOUND", "Dokument nicht gefunden.");
  const row = await one(ctx.db, "UPDATE documents SET deleted_at = now() WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING id", [actor.workspaceId, id]);
  if (!row) throw new ServiceError(404, "NOT_FOUND", "Dokument nicht gefunden.");
  await audit(ctx.db, actor, "document.deleted", "document", id);
}

export async function getDocument(ctx: AppContext, actor: Actor, id: string): Promise<{ name: string; data: Buffer }> {
  if (!UUID.test(id)) throw new ServiceError(404, "NOT_FOUND", "Dokument nicht gefunden.");
  const row = await one<{ name: string; data: Buffer }>(ctx.db, "SELECT name, data FROM documents WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL", [actor.workspaceId, id]);
  if (!row) throw new ServiceError(404, "NOT_FOUND", "Dokument nicht gefunden.");
  return row;
}

/**
 * Choose the PDFs that go out with a draft. This is a change to the draft: the
 * version goes up and earlier approvals no longer count, so a person approves
 * text and files together.
 */
export async function setDraftDocuments(ctx: AppContext, actor: Actor, draftId: string, input: { documentIds: string[]; expectedVersion: number }): Promise<{ version: number }> {
  requireRole(actor, ["owner", "agent"]);
  if (!UUID.test(draftId)) throw new ServiceError(404, "NOT_FOUND", "Entwurf nicht gefunden.");
  const ids = [...new Set(input.documentIds)];
  if (ids.some((id) => !UUID.test(id))) throw new ServiceError(400, "INVALID", "Ungültige Dokument-ID.");
  if (ids.length > MAX_REPLY_DOCUMENTS) throw new ServiceError(400, "TOO_MANY", `Höchstens ${MAX_REPLY_DOCUMENTS} Dokumente je Antwort.`);
  return withTx(ctx.db, async (tx) => {
    const draft = await one<{ status: string; version: number; kind: ChannelKind }>(
      tx,
      `SELECT d.status, d.version, cc.kind FROM drafts d
         JOIN conversations c ON c.workspace_id = d.workspace_id AND c.id = d.conversation_id
         JOIN channel_connections cc ON cc.workspace_id = c.workspace_id AND cc.id = c.connection_id
        WHERE d.workspace_id = $1 AND d.id = $2 FOR UPDATE OF d`,
      [actor.workspaceId, draftId],
    );
    if (!draft) throw new ServiceError(404, "NOT_FOUND", "Entwurf nicht gefunden.");
    if (!["proposed", "edited"].includes(draft.status)) throw new ServiceError(409, "DRAFT_CLOSED", "Dieser Entwurf ist nicht mehr aktuell.");
    if (draft.version !== input.expectedVersion) throw new ServiceError(409, "VERSION_CONFLICT", "Der Entwurf wurde zwischenzeitlich geändert. Bitte neu laden.");
    if (ids.length > 0 && !REPLY_FILES[draft.kind].supported) throw new ServiceError(409, "NOT_SUPPORTED", REPLY_FILES[draft.kind].note);
    const docs = ids.length ? await many<{ id: string; size: number }>(tx, "SELECT id, size FROM documents WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL", [actor.workspaceId, ids]) : [];
    if (docs.length !== ids.length) throw new ServiceError(404, "NOT_FOUND", "Dokument nicht gefunden.");
    if (docs.reduce((sum, d) => sum + d.size, 0) > MAX_DOCUMENT_BYTES) throw new ServiceError(413, "TOO_LARGE", "Zusammen sind die Dokumente zu groß (höchstens 3 MB je Antwort). Bitte weniger anhängen.");
    const updated = await one<{ version: number }>(
      tx,
      "UPDATE drafts SET document_ids = $3::uuid[], version = version + 1, status = 'edited', updated_by = $4, updated_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING version",
      [actor.workspaceId, draftId, ids, actorId(actor)],
    );
    await tx.query("UPDATE approvals SET invalidated_at = now(), invalidation_reason = 'Anhänge geändert' WHERE workspace_id = $1 AND draft_id = $2 AND invalidated_at IS NULL", [actor.workspaceId, draftId]);
    await tx.query("UPDATE outbox SET state = 'suppressed', last_error = 'Anhänge geändert', updated_at = now() WHERE workspace_id = $1 AND draft_id = $2 AND state = 'planned'", [actor.workspaceId, draftId]);
    await audit(tx, actor, "draft.documents_set", "draft", draftId, { documents: ids.length, version: updated!.version });
    return { version: updated!.version };
  });
}

/** Files for a queued reply, exactly as approved (also when removed from the list since). */
export async function outboxAttachments(ctx: AppContext, workspaceId: string, ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await many<{ id: string; name: string; data: Buffer }>(ctx.db, "SELECT id, name, data FROM documents WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [workspaceId, ids]);
  if (rows.length !== ids.length) throw new Error("Ein freigegebenes Dokument fehlt.");
  return ids.map((id) => rows.find((r) => r.id === id)!).map((r) => ({ name: r.name, contentType: "application/pdf", data: r.data }));
}
