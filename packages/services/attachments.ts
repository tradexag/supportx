import type { AttachmentFile, AttachmentInfo } from "../core/contracts.ts";
import { HttpError } from "../connectors/http.ts";
import { one } from "../storage/db.ts";
import { channelFor, loadChannelConnection } from "./connections.ts";
import { ServiceError, type Actor, type AppContext } from "./context.ts";

const UUID = /^[0-9a-f-]{36}$/i;
/** Shown in the page; everything else is offered as a download only. */
export const INLINE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_BYTES = 15 * 1024 * 1024;

async function channelForMessage(ctx: AppContext, actor: Actor, messageId: string) {
  if (!UUID.test(messageId)) throw new ServiceError(404, "NOT_FOUND", "Nachricht nicht gefunden.");
  const msg = await one<{ external_message_id: string; external_thread_key: string; connection_id: string; has_attachments: boolean }>(
    ctx.db,
    "SELECT m.external_message_id, c.external_thread_key, m.connection_id, m.has_attachments FROM messages m JOIN conversations c ON c.workspace_id = m.workspace_id AND c.id = m.conversation_id WHERE m.workspace_id = $1 AND m.id = $2",
    [actor.workspaceId, messageId],
  );
  if (!msg) throw new ServiceError(404, "NOT_FOUND", "Nachricht nicht gefunden.");
  const channel = await channelFor(ctx, ctx.db, await loadChannelConnection(ctx.db, actor.workspaceId, msg.connection_id));
  if (!channel.listAttachments || !channel.getAttachment) throw new ServiceError(409, "NOT_SUPPORTED", "Anhänge dieser Verbindung kann SupportX noch nicht anzeigen. Bitte im Marktplatz öffnen.");
  return { msg, channel };
}

function providerError(error: unknown): never {
  if (error instanceof ServiceError) throw error;
  if (error instanceof HttpError && error.status === 404) throw new ServiceError(404, "NOT_FOUND", "Anhang beim Anbieter nicht mehr vorhanden.");
  throw new ServiceError(502, "PROVIDER_ERROR", `Anhänge konnten nicht geladen werden: ${(error as Error).message}`);
}

/** Customer attachments of one message, read live from the mailbox or marketplace (nothing is stored). */
export async function listMessageAttachments(ctx: AppContext, actor: Actor, messageId: string): Promise<Array<AttachmentInfo & { inline: boolean }>> {
  const { msg, channel } = await channelForMessage(ctx, actor, messageId);
  if (!msg.has_attachments) return [];
  try {
    return (await channel.listAttachments!(msg.external_message_id, msg.external_thread_key)).map((a) => ({ ...a, inline: INLINE_TYPES.has(a.contentType) }));
  } catch (error) {
    providerError(error);
  }
}

export async function getMessageAttachment(ctx: AppContext, actor: Actor, messageId: string, attachmentId: string): Promise<AttachmentFile & { inline: boolean }> {
  if (!attachmentId || attachmentId.length > 1000) throw new ServiceError(404, "NOT_FOUND", "Anhang nicht gefunden.");
  const { msg, channel } = await channelForMessage(ctx, actor, messageId);
  // Only ids the provider lists for this very message: a client-supplied id never reaches another message.
  let listed: AttachmentInfo[];
  try {
    listed = await channel.listAttachments!(msg.external_message_id, msg.external_thread_key);
  } catch (error) {
    providerError(error);
  }
  if (!listed.some((a) => a.id === attachmentId)) throw new ServiceError(404, "NOT_FOUND", "Anhang nicht gefunden.");
  let file: AttachmentFile;
  try {
    file = await channel.getAttachment!(msg.external_message_id, msg.external_thread_key, attachmentId);
  } catch (error) {
    providerError(error);
  }
  if (file.data.length > MAX_BYTES) throw new ServiceError(413, "TOO_LARGE", "Anhang ist zu groß für die Anzeige. Bitte im Postfach öffnen.");
  return { ...file, inline: INLINE_TYPES.has(file.contentType) };
}
