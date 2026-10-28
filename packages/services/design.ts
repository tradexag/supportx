import { checkTheme, readDesignMd, workspaceThemeSchema, type DesignReading, type WorkspaceTheme } from "../core/design-md.ts";
import { one } from "../storage/db.ts";
import { audit } from "./audit.ts";
import { requireRole, ServiceError, type Actor, type AppContext } from "./context.ts";

const MAX_CHARS = 200_000;

/** Reads an uploaded DESIGN.md and shows what would be taken over. Nothing is saved yet. */
export function previewDesign(actor: Actor, text: string): DesignReading {
  requireRole(actor, ["owner"]);
  if (text.length > MAX_CHARS) throw new ServiceError(413, "TOO_LARGE", "Die Datei ist zu groß (höchstens 200 KB).");
  if (text.includes("\u0000")) throw new ServiceError(400, "INVALID", "Das ist keine Textdatei. Bitte eine .md-Datei hochladen.");
  return readDesignMd(text);
}

/** Saves the look for this workspace. The values are checked again on the server. */
export async function saveDesign(ctx: AppContext, actor: Actor, input: unknown): Promise<{ theme: WorkspaceTheme; warnings: string[] }> {
  requireRole(actor, ["owner"]);
  const parsed = workspaceThemeSchema.safeParse(input);
  if (!parsed.success) throw new ServiceError(400, "INVALID", "Ungültige Designwerte.");
  const { theme, warnings } = checkTheme(parsed.data);
  await ctx.db.query("UPDATE workspaces SET theme = $2 WHERE id = $1", [actor.workspaceId, JSON.stringify(theme)]);
  await audit(ctx.db, actor, "design.saved", "workspace", actor.workspaceId, { fields: Object.keys(theme.colors).length });
  return { theme, warnings };
}

export async function resetDesign(ctx: AppContext, actor: Actor): Promise<void> {
  requireRole(actor, ["owner"]);
  await ctx.db.query("UPDATE workspaces SET theme = NULL WHERE id = $1", [actor.workspaceId]);
  await audit(ctx.db, actor, "design.reset", "workspace", actor.workspaceId);
}

export async function workspaceTheme(ctx: AppContext, actor: Actor): Promise<WorkspaceTheme | null> {
  const row = await one<{ theme: unknown }>(ctx.db, "SELECT theme FROM workspaces WHERE id = $1", [actor.workspaceId]);
  if (!row?.theme) return null;
  const parsed = workspaceThemeSchema.safeParse(row.theme);
  return parsed.success ? parsed.data : null;
}
