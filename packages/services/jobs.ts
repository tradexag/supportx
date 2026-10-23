import type { Db, Queryable } from "../storage/db.ts";

export type JobType = "mail.sync" | "case.enrich" | "case.draft" | "outbox.dispatch" | "outbox.reconcile" | "mail.subscription";

export interface JobRow {
  id: string;
  workspace_id: string | null;
  type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

/**
 * Enqueue a job in the caller's transaction, so ingress and follow-up work
 * commit together. A dedupe key collapses repeated requests while one is pending.
 */
export async function enqueue(q: Queryable, job: { workspaceId: string | null; type: JobType; payload?: Record<string, unknown>; dedupeKey?: string; delayMs?: number; maxAttempts?: number }): Promise<void> {
  await q.query(
    `INSERT INTO jobs (workspace_id, type, payload, dedupe_key, run_at, max_attempts)
     VALUES ($1, $2, $3, $4, now() + ($5::int * interval '1 millisecond'), $6)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running') DO NOTHING`,
    [job.workspaceId, job.type, JSON.stringify(job.payload ?? {}), job.dedupeKey ?? null, job.delayMs ?? 0, job.maxAttempts ?? 5],
  );
}

export async function claimJob(db: Db, types?: ReadonlyArray<JobType>): Promise<JobRow | null> {
  // Recover jobs whose worker died mid-run.
  await db.query("UPDATE jobs SET status = 'queued', locked_until = NULL, updated_at = now() WHERE status = 'running' AND locked_until < now()");
  const result = await db.query<JobRow>(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_until = now() + interval '5 minutes', updated_at = now()
     WHERE id = (
       SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now() AND ($1::text[] IS NULL OR type = ANY($1))
       ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id, workspace_id, type, payload, attempts, max_attempts`,
    [types ?? null],
  );
  return result.rows[0] ?? null;
}

export async function completeJob(db: Db, id: string): Promise<void> {
  await db.query("UPDATE jobs SET status = 'done', locked_until = NULL, last_error = NULL, updated_at = now() WHERE id = $1", [id]);
}

/** Retry with exponential backoff; after max attempts the job stays visible as failed. */
export async function failJob(db: Db, job: JobRow, error: string, retryable: boolean): Promise<void> {
  if (retryable && job.attempts < job.max_attempts) {
    const delayMs = Math.min(15 * 60_000, 2 ** job.attempts * 5_000);
    await db.query(
      "UPDATE jobs SET status = 'queued', locked_until = NULL, last_error = $2, run_at = now() + ($3::int * interval '1 millisecond'), updated_at = now() WHERE id = $1",
      [job.id, error.slice(0, 2000), delayMs],
    );
  } else {
    await db.query("UPDATE jobs SET status = 'failed', locked_until = NULL, last_error = $2, updated_at = now() WHERE id = $1", [job.id, error.slice(0, 2000)]);
  }
}
