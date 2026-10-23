import type { CaseIntent, CaseRisk, MessageAddress, SourcePlatform } from "./contracts.ts";

export interface RoutingRule {
  id: string;
  priority: number;
  matchType: "from_domain" | "from_address" | "to_address" | "subject_contains";
  pattern: string;
  sourcePlatform: SourcePlatform;
  merchantAccountId: string | null;
}

export interface RoutingDecision {
  sourcePlatform: SourcePlatform;
  merchantAccountId: string | null;
  ruleId: string | null;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).toLowerCase() : "";
}

function domainMatches(domain: string, pattern: string): boolean {
  const p = pattern.toLowerCase().replace(/^@/, "");
  return domain === p || domain.endsWith(`.${p}`);
}

/**
 * Decide source platform and merchant account from operator-configured rules.
 * Rules are evaluated against transport metadata only (sender, recipient, subject);
 * text in the message body can never select a platform or an account.
 */
export function routeMessage(
  message: { from: MessageAddress; to: ReadonlyArray<MessageAddress>; subject: string },
  rules: ReadonlyArray<RoutingRule>,
  fallback: { sourcePlatform: SourcePlatform; merchantAccountId: string | null },
): RoutingDecision {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const from = message.from.address.toLowerCase();
  for (const rule of sorted) {
    const pattern = rule.pattern.trim().toLowerCase();
    if (!pattern) continue;
    const hit =
      (rule.matchType === "from_domain" && domainMatches(domainOf(from), pattern)) ||
      (rule.matchType === "from_address" && from === pattern) ||
      (rule.matchType === "to_address" && message.to.some((t) => t.address.toLowerCase() === pattern)) ||
      (rule.matchType === "subject_contains" && message.subject.toLowerCase().includes(pattern));
    if (hit) return { sourcePlatform: rule.sourcePlatform, merchantAccountId: rule.merchantAccountId, ruleId: rule.id };
  }
  return { ...fallback, ruleId: null };
}

const HEALTH = /\b(nebenwirkung\w*|dosierung|dosis|einnahme|rezept\w*|wechselwirkung\w*|allergi\w*|schwanger\w*|arzt|ärztin|apotheker\w*|symptom\w*|medikament\w*|side effects?|dosage|prescription)\b/i;
const LEGAL = /\b(anwalt|rechtsanwalt|abmahnung|klage|gericht|verbraucherzentrale|lawyer|lawsuit)\b/i;
const REFUND = /\b(erstatt\w*|geld zurück|rückerstattung|refund\w*|money back|gutschrift)\b/i;
const REPLACEMENT = /\b(ersatz\w*|neu (zu)?senden|nachliefer\w*|replacement|resend)\b/i;
const CANCEL = /\b(storn\w*|widerruf\w*|cancel\w*)\b/i;
const DISPUTED = /\b(nicht (erhalten|angekommen|bekommen)|nie angekommen|never (arrived|received)|not received|(paket|sendung) (ist )?(weg|verloren)|als zugestellt.{0,40}aber)\b/i;

/** Deterministic risk screen. AI suggestions are added, never subtracted. */
export function detectRisks(text: string): CaseRisk[] {
  const risks = new Set<CaseRisk>();
  if (HEALTH.test(text)) risks.add("health");
  if (LEGAL.test(text)) risks.add("legal");
  if (REFUND.test(text)) risks.add("refund");
  if (REPLACEMENT.test(text)) risks.add("replacement");
  if (CANCEL.test(text)) risks.add("cancellation");
  if (DISPUTED.test(text)) risks.add("delivery_disputed");
  return [...risks];
}

const INTENT_RULES: ReadonlyArray<[CaseIntent, RegExp]> = [
  ["damaged_item", /\b(beschädigt\w*|kaputt\w*|defekt\w*|zerbrochen\w*|ausgelaufen\w*|damaged|broken|leaking)\b/i],
  ["wrong_item", /\b(falsche[nrs]? (artikel|produkt|ware|lieferung|größe|farbe)|falsch geliefert|anderen artikel|nicht bestellt|wrong (item|product|size))\b/i],
  ["return_request", /\b(retoure\w*|zurücksenden|zurückschicken|rücksend\w*|umtausch\w*|return label|return\w*)\b/i],
  ["parcel_status", /\b(wo (ist|bleibt) (mein|meine|die)|paket\w*|sendung\w*|lieferung\w*|tracking|sendungsverfolgung|versand\w*|wann kommt|where is my|not (yet )?arrived|noch nicht (angekommen|da|erhalten))\b/i],
  ["invoice", /\b(rechnung\w*|invoice|beleg|quittung)\b/i],
  ["product_question", /\b(frage zu(m)? (artikel|produkt)|inhaltsstoff\w*|passt das|kompatibel|haltbarkeit)\b/i],
];

/** Keyword classifier used when no AI provider is configured, and as a cross-check. */
export function classifyIntentByRules(text: string): CaseIntent {
  for (const [intent, pattern] of INTENT_RULES) if (pattern.test(text)) return intent;
  return "other";
}

/**
 * Strip quoted history from an email body so classification and AI input focus on
 * the newest customer text. The full body stays stored and visible.
 */
export function newestEmailText(body: string): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^\s*(am .{3,80} schrieb .{1,120}:|on .{3,80} wrote:|-{2,}\s*(original|ursprüngliche) ?(message|nachricht)|von:\s.+|from:\s.+)\s*$/i.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim() || body.trim();
}
