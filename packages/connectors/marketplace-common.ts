import type { ReplyOutcome } from "../core/contracts.ts";
import { HttpError } from "./http.ts";

/**
 * Shared helpers for the native marketplace adapters (eBay, Kaufland, Mirakl).
 * Marketplace APIs have no custom headers, so a sent reply is recognised again
 * (echo, reconciliation) by its exact text, compared after normalising
 * whitespace and line endings only.
 */
export function normaliseText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

export function sameText(a: string, b: string): boolean {
  return normaliseText(a) === normaliseText(b);
}

/** Map a failed send call to the outbox outcome: uncertain unless the provider definitely refused it. */
export function sendFailure(error: unknown): ReplyOutcome {
  if (error instanceof HttpError) {
    if (error.uncertain) return { state: "uncertain", error: error.message };
    return { state: "rejected", error: error.message, retryable: error.retryable };
  }
  return { state: "uncertain", error: (error as Error).message };
}

/** Thread keys carry a platform prefix so they never collide with mail conversation ids. */
export function threadId(threadKey: string, prefix: string): string {
  if (!threadKey.startsWith(prefix)) throw new Error(`Unerwarteter Vorgangsschlüssel für diesen Kanal: ${threadKey}`);
  const id = threadKey.slice(prefix.length);
  if (!id) throw new Error("Vorgangsschlüssel ohne Kennung.");
  return id;
}

export function isoOrNow(value: unknown): Date {
  const date = typeof value === "string" ? new Date(value) : new Date(NaN);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

/** Cursor = ISO time; the next round starts a few minutes earlier, duplicates are absorbed by ingestion. */
export function cursorStart(cursor: string | undefined, initialSyncDays: number, overlapMs = 10 * 60_000): Date {
  const parsed = cursor ? new Date(cursor) : new Date(NaN);
  if (Number.isNaN(parsed.getTime())) return new Date(Date.now() - initialSyncDays * 86_400_000);
  return new Date(parsed.getTime() - overlapMs);
}
