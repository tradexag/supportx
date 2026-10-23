import type { Queryable } from "../storage/db.ts";
import type { Actor } from "./context.ts";

/** Decisions and identifiers only; message bodies are not copied into the audit log. */
export async function audit(q: Queryable, actor: Actor | { type: "system"; workspaceId: string }, action: string, targetType: string, targetId: string | null, details: Record<string, unknown> = {}): Promise<void> {
  await q.query(
    "INSERT INTO audit_events (workspace_id, actor_type, actor_id, action, target_type, target_id, details) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [actor.workspaceId, actor.type, actor.type === "user" ? actor.userId : null, action, targetType, targetId, JSON.stringify(details)],
  );
}
