import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, MATCH_LABEL, OUTBOX_LABEL, PLATFORM_LABEL } from "./api.ts";
import { CaseView } from "./CaseView.tsx";

type Role = "owner" | "agent" | "viewer";

interface CaseRow {
  id: string;
  subject: string;
  status: string;
  category: "support" | "info";
  category_reason: string | null;
  source_platform: string;
  customer_address: string | null;
  customer_name: string | null;
  order_match_status: string;
  last_message_at: string | null;
  last_error: string | null;
  merchant_account_name: string | null;
  assignee_name: string | null;
  draft_status: string | null;
  intent: string | null;
  outbox_state: string | null;
  message_count: number;
}

const FILTERS = [
  { id: "open", label: "Anfragen", count: "open" },
  { id: "needs_attention", label: "Klärung nötig", count: "needs_attention" },
  { id: "waiting", label: "Wartet", count: null },
  { id: "closed", label: "Erledigt", count: null },
  { id: "info", label: "Werbung & Infos", count: "info" },
  { id: "all", label: "Alle", count: null },
] as const;
type Counts = { open: number; needs_attention: number; info: number };

/** One short line saying where the case stands, instead of a row of badges. */
function caseState(c: CaseRow): { text: string; tone: "ok" | "warn" | "bad" | "muted" } {
  if (c.category === "info") return { text: c.category_reason ? `Erkannt: ${c.category_reason}` : "Werbung oder Info", tone: "muted" };
  if (c.last_error) return { text: "Fehler, bitte ansehen", tone: "bad" };
  if (c.outbox_state === "delivery_uncertain" || c.outbox_state === "failed") return { text: OUTBOX_LABEL[c.outbox_state] ?? c.outbox_state, tone: "bad" };
  if (c.outbox_state && c.outbox_state !== "suppressed") return { text: `Antwort ${OUTBOX_LABEL[c.outbox_state] ?? c.outbox_state}`, tone: "ok" };
  if (c.status === "closed") return { text: "Erledigt", tone: "muted" };
  if (c.status === "waiting") return { text: "Wartet auf Kunde", tone: "muted" };
  if (c.order_match_status === "pending") return { text: "Wird vorbereitet …", tone: "muted" };
  if (c.draft_status === "proposed" || c.draft_status === "edited") {
    const match = MATCH_LABEL[c.order_match_status];
    return c.order_match_status === "unique" ? { text: "Antwortentwurf bereit", tone: "ok" } : { text: `Entwurf bereit · Bestellung ${match?.label ?? c.order_match_status}`, tone: "warn" };
  }
  return { text: `Bestellung ${MATCH_LABEL[c.order_match_status]?.label ?? c.order_match_status}`, tone: "warn" };
}

export const INTENT_LABEL: Record<string, string> = {
  parcel_status: "Paketstatus",
  wrong_item: "Falscher Artikel",
  damaged_item: "Beschädigt",
  return_request: "Rücksendung",
  invoice: "Rechnung",
  product_question: "Produktfrage",
  other: "Sonstiges",
};

export function Inbox({ workspaceId, role }: { workspaceId: string; role: Role }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("open");
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ cases: CaseRow[]; counts: Counts }>("GET", `/api/w/${workspaceId}/cases?filter=${filter}`);
      setCases(data.cases);
      setCounts(data.counts);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [workspaceId, filter]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="inbox">
      <aside className="case-list">
        <div className="filters">
          {FILTERS.map((f) => (
            <button key={f.id} className={filter === f.id ? "chip active" : "chip"} onClick={() => { setFilter(f.id); setSelected(null); }}>
              {f.label}{f.count && counts ? <span className="count">{counts[f.count]}</span> : null}
            </button>
          ))}
        </div>
        {filter === "info" && <p className="muted small pad">Newsletter, Aktionen und Partner-Infos. Sie bekommen keinen Antwortentwurf. Ist eine Kundenanfrage dabei, im Fall auf „Ist eine Kundenanfrage“ klicken.</p>}
        {error && <p className="error pad">{error}</p>}
        {cases.length === 0 && <p className="muted pad">Hier ist gerade nichts.</p>}
        <ul>
          {cases.map((c) => {
            const state = caseState(c);
            return (
              <li key={c.id} className={selected === c.id ? "case-item selected" : "case-item"} onClick={() => setSelected(c.id)}>
                <div className="row">
                  <span className="muted small ellipsis">{c.customer_name || c.customer_address}</span>
                  <span className="muted small nowrap">{fmtDate(c.last_message_at)}</span>
                </div>
                <div className="subject">{c.subject || "(ohne Betreff)"}</div>
                <div className="row wrap small">
                  <span className="tag">{PLATFORM_LABEL[c.source_platform] ?? c.source_platform}</span>
                  {c.category === "support" && c.intent && <span className="muted">{INTENT_LABEL[c.intent] ?? c.intent}</span>}
                  <span className={`state ${state.tone}`}>{state.text}</span>
                </div>
              </li>
            );
          })}
        </ul>
      </aside>
      <main className="case-detail">
        {selected ? <CaseView key={selected} workspaceId={workspaceId} caseId={selected} role={role} onChanged={load} /> : <div className="center muted">Fall auswählen</div>}
      </main>
    </div>
  );
}
