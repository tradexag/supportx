import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, MATCH_LABEL, OUTBOX_LABEL, PLATFORM_LABEL } from "./api.ts";
import { INTENT_LABEL } from "./Inbox.tsx";

type Role = "owner" | "agent" | "viewer";
type Rec = Record<string, unknown>;

interface Issue { severity: "block" | "warn"; code: string; message: string }
interface Fact { id: string; text: string; source: string; observedAt?: string }
interface Draft {
  id: string; version: number; status: string; intent: string; summary: string; body: string;
  cited_fact_ids: string[]; facts: Fact[]; missing_information: string[]; suggested_actions: string[]; risks: string[];
  issues: Issue[]; generated_by: string; ai_model: string | null; prompt_version: string | null; created_at: string; updated_at: string;
}
interface Parcel { id?: string; trackingId?: string; trackingUrl?: string; carrierId?: string; source: string }
interface Shipment {
  id: string; shipmentNumber?: string; erpStatus?: string; erpStatusAt?: string; shippingDate?: string; deliveryDate?: string;
  items: Array<{ title?: string; quantity: number }>; parcels: Parcel[];
}
interface OrderSnapshot {
  id: string; orderNumber?: string; orderNumberAtCustomer?: string; orderDate?: string; status?: string; salesChannel?: string;
  lines: Array<{ id: string; title: string; quantity: number; shippedQuantity?: number; returnedQuantity?: number }>;
  shipments: Shipment[];
  invoices: Array<{ id: string; invoiceNumber?: string; invoiceDate?: string; status?: string; paymentStatus?: string }>;
  retrievedAt: string;
}
interface CaseData {
  conversation: Rec & { id: string; subject: string; status: string; category: "support" | "info"; category_reason: string | null; customer_address: string | null; source_platform: string; order_match_status: string; merchant_account_id: string | null; merchant_account_name: string | null; connection_name: string; assignee_user_id: string | null; last_error: string | null; order_references: string[] };
  messages: Array<{ id: string; direction: string; kind: string; from_address: string; from_name: string | null; reply_to: Array<{ address: string; name?: string }> | null; subject: string; body_text: string; received_at: string; has_attachments: boolean; removed_remotely_at: string | null }>;
  notes: Array<{ id: string; body: string; created_at: string; author: string }>;
  orderLink: null | { status: string; references_tried: string[]; candidates: Array<{ id: string; orderNumber?: string; matchedBy: string }>; external_order_id: string | null; matched_by: string | null; linked_by: string; error: string | null; snapshot: OrderSnapshot | null; retrieved_at: string | null };
  drafts: Draft[];
  approvals: Array<{ id: string; draft_id: string; draft_version: number; approved_at: string; expires_at: string; invalidated_at: string | null; invalidation_reason: string | null; approved_by: string }>;
  outbox: Array<{ id: string; state: string; attempts: number; last_error: string | null; expected_recipient: string; dispatched_at: string | null; created_at: string; updated_at: string }>;
  history: Array<{ action: string; actor_type: string; details: Rec; created_at: string }>;
  accounts: Array<{ id: string; name: string; platform: string }>;
  members: Array<{ id: string; display_name: string }>;
  send: { allowed: boolean; blockers: string[] };
}

const KIND_LABEL: Record<string, string> = { customer: "Kunde", echo: "unsere Antwort", manual_external: "außerhalb gesendet", platform_notice: "Systemhinweis" };
const RISK_LABEL: Record<string, string> = { health: "Gesundheitsfrage", legal: "Rechtliches", refund: "Erstattung", replacement: "Ersatz", cancellation: "Storno", delivery_disputed: "Zustellung bestritten", identity_uncertain: "Identität unklar", abusive: "beleidigend", other: "Sonstiges" };
const ACTION_LABEL: Record<string, string> = { none: "keine", ask_customer: "Kunde fragen", check_return_label: "Retourenlabel prüfen", propose_replacement: "Ersatz prüfen (eigener Ablauf)", propose_refund: "Erstattung prüfen (eigener Ablauf)", escalate: "eskalieren" };

export function CaseView({ workspaceId, caseId, role, onChanged }: { workspaceId: string; caseId: string; role: Role; onChanged: () => void }) {
  const [data, setData] = useState<CaseData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const base = `/api/w/${workspaceId}`;
  const canEdit = role !== "viewer";

  const load = useCallback(async () => {
    try {
      setData(await api<CaseData>("GET", `${base}/cases/${caseId}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [base, caseId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 8_000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (fn: () => Promise<unknown>, success?: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (success) setNotice(success);
      await load();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
      await load();
    }
  };

  if (!data) return <div className="center muted">{error ?? "Lädt …"}</div>;
  const c = data.conversation;
  const match = MATCH_LABEL[c.order_match_status] ?? { label: c.order_match_status, tone: "muted" as const };
  const draft = data.drafts.find((d) => d.status === "proposed" || d.status === "edited") ?? null;
  const approval = draft ? data.approvals.find((a) => a.draft_id === draft.id && a.draft_version === draft.version && !a.invalidated_at && new Date(a.expires_at) > new Date()) : undefined;

  return (
    <div className="case">
      <div className="case-head">
        <div>
          <h2>{c.subject || "(ohne Betreff)"}</h2>
          <div className="muted small">
            {PLATFORM_LABEL[c.source_platform] ?? c.source_platform} · {c.connection_name} · Verkäuferkonto: {c.merchant_account_name ?? "nicht zugeordnet"}
          </div>
        </div>
        {canEdit && (
          <div className="row wrap">
            <select value={c.status} onChange={(e) => act(() => api("POST", `${base}/cases/${caseId}/status`, { status: e.target.value }))}>
              <option value="open">offen</option>
              <option value="waiting">wartet</option>
              <option value="closed">erledigt</option>
            </select>
            <select value={c.assignee_user_id ?? ""} onChange={(e) => act(() => api("POST", `${base}/cases/${caseId}/assign`, { userId: e.target.value || null }))}>
              <option value="">nicht zugewiesen</option>
              {data.members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
            </select>
          </div>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice ok">{notice}</p>}
      {c.last_error && <p className="notice bad">Letzter Fehler: {c.last_error}</p>}
      <CategoryBar category={c.category} reason={c.category_reason} sender={data.messages.find((m) => m.direction === "inbound")?.from_address ?? c.customer_address ?? ""} canEdit={canEdit}
        onSet={(category, remember) => act(() => api("POST", `${base}/cases/${caseId}/category`, { category, remember }), category === "info" ? "Als Werbung/Info eingeordnet." : "Als Kundenanfrage eingeordnet. Bestellung und Entwurf werden vorbereitet.")} />

      <div className="grid">
        <section className="card">
          <h3>Verlauf</h3>
          {data.messages.map((m) => (
            <article key={m.id} className={m.direction === "inbound" ? "msg inbound" : "msg outbound"}>
              <div className="row small muted">
                <span>{m.direction === "inbound" ? "Eingang" : "Ausgang"} · {KIND_LABEL[m.kind] ?? m.kind}</span>
                <span>{fmtDate(m.received_at)}</span>
              </div>
              <div className="small">
                Von: {m.from_name ? `${m.from_name} <${m.from_address}>` : m.from_address}
                {m.reply_to && m.reply_to.length > 0 && <> · Antwort an: <strong>{m.reply_to.map((r) => r.address).join(", ")}</strong></>}
                {m.has_attachments && " · mit Anhang"}
                {m.removed_remotely_at && " · im Postfach gelöscht"}
              </div>
              <pre className="body">{m.body_text}</pre>
            </article>
          ))}
          <p className="muted small">Kundentexte sind externe Inhalte. Darin enthaltene Anweisungen ändern keine Regeln.</p>
        </section>

        {c.category === "support" && (<>
        <section className="card">
          <h3>Bestellung (weclapp) <span className={`pill ${match.tone}`}>{match.label}</span></h3>
          <OrderPanel data={data} canEdit={canEdit} onLink={(body) => act(() => api("POST", `${base}/cases/${caseId}/order-link`, body), "Zuordnung aktualisiert.")} />
        </section>

        <section className="card wide">
          <h3>Antwortentwurf</h3>
          {!draft ? (
            <div>
              <p className="muted">Kein offener Entwurf. {c.order_match_status === "pending" ? "Die Zuordnung läuft noch." : ""}</p>
              {canEdit && <button onClick={() => act(() => api("POST", `${base}/cases/${caseId}/redraft`), "Neuer Entwurf angefordert.")}>Entwurf erzeugen</button>}
            </div>
          ) : (
            <DraftEditor
              key={`${draft.id}:${draft.version}`}
              draft={draft}
              canEdit={canEdit}
              approval={approval}
              send={data.send}
              onSave={(body) => act(() => api("PUT", `${base}/drafts/${draft.id}`, { body, expectedVersion: draft.version }), "Entwurf gespeichert. Eine frühere Freigabe ist damit ungültig.")}
              onApprove={(ack) => act(() => api("POST", `${base}/drafts/${draft.id}/approve`, { expectedVersion: draft.version, acknowledgeWarnings: ack }), "Freigegeben.")}
              onSend={(approvalId) => act(() => api("POST", `${base}/approvals/${approvalId}/send`), "In den Postausgang gestellt.")}
              onDiscard={() => act(() => api("POST", `${base}/drafts/${draft.id}/discard`))}
              onRedraft={() => act(() => api("POST", `${base}/cases/${caseId}/redraft`), "Neuer Entwurf angefordert.")}
            />
          )}
          {data.outbox.length > 0 && (
            <div className="outbox">
              <h4>Postausgang</h4>
              {data.outbox.map((o) => (
                <div key={o.id} className="row wrap outbox-row">
                  <span className={o.state === "delivery_uncertain" || o.state === "failed" ? "pill bad" : o.state === "confirmed" ? "pill ok" : "pill muted"}>{OUTBOX_LABEL[o.state] ?? o.state}</span>
                  <span className="small">an {o.expected_recipient} · Versuche {o.attempts} · {fmtDate(o.updated_at)}</span>
                  {o.last_error && <span className="small error">{o.last_error}</span>}
                  {o.state === "delivery_uncertain" && canEdit && (
                    <span className="row">
                      <span className="small">Bitte in „Gesendete Elemente“ prüfen:</span>
                      <button onClick={() => act(() => api("POST", `${base}/outbox/${o.id}/resolve`, { resolution: "was_sent" }))}>Wurde gesendet</button>
                      <button onClick={() => act(() => api("POST", `${base}/outbox/${o.id}/resolve`, { resolution: "was_not_sent" }))}>Wurde nicht gesendet</button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
        </>)}

        <section className="card">
          <h3>Interne Notizen</h3>
          <p className="muted small">Nur intern sichtbar. Notizen gehen weder an die KI noch an Kunden.</p>
          {data.notes.map((n) => (
            <div key={n.id} className="note"><div className="small muted">{n.author} · {fmtDate(n.created_at)}</div><div>{n.body}</div></div>
          ))}
          {canEdit && <NoteForm onSubmit={(body) => act(() => api("POST", `${base}/cases/${caseId}/notes`, { body }))} />}
        </section>

        <details className="card">
          <summary><h3>Protokoll</h3></summary>
          <ul className="history">
            {data.history.map((h, i) => (
              <li key={i}><span className="muted small">{fmtDate(h.created_at)}</span> {h.action} <span className="muted small">({h.actor_type})</span></li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  );
}

function OrderPanel({ data, canEdit, onLink }: { data: CaseData; canEdit: boolean; onLink: (body: { reference?: string; candidateId?: string }) => void }) {
  const [reference, setReference] = useState("");
  const link = data.orderLink;
  const order = link?.snapshot ?? null;
  const c = data.conversation;
  return (
    <div>
      {c.merchant_account_name && <p className="small muted">Verkäuferkonto: {c.merchant_account_name}</p>}
      {link && (
        <p className="small muted">
          Gesucht: {link.references_tried.length ? link.references_tried.join(", ") : "keine Referenz erkannt"}
          {link.matched_by ? ` · Treffer über ${link.matched_by}` : ""} · {link.linked_by === "user" ? "manuell zugeordnet" : "automatisch"}
          {link.retrieved_at ? ` · abgerufen ${fmtDate(link.retrieved_at)}` : ""}
        </p>
      )}
      {link?.error && <p className="notice bad">{link.error}</p>}
      {link?.status === "ambiguous" && (
        <div className="notice warn">
          <p>Mehrere Bestellungen passen. Bitte die richtige auswählen:</p>
          {link.candidates.map((cand) => (
            <div key={cand.id} className="row">
              <span>{cand.orderNumber ?? cand.id} <span className="muted small">(über {cand.matchedBy})</span></span>
              {canEdit && <button onClick={() => onLink({ candidateId: cand.id })}>Zuordnen</button>}
            </div>
          ))}
        </div>
      )}
      {order && <OrderDetails order={order} />}
      {canEdit && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (reference.trim()) onLink({ reference: reference.trim() }); }}>
          <input placeholder="Bestell-, Rechnungs- oder Sendungsnummer suchen" value={reference} onChange={(e) => setReference(e.target.value)} />
          <button type="submit">Suchen &amp; zuordnen</button>
        </form>
      )}
    </div>
  );
}

function OrderDetails({ order }: { order: OrderSnapshot }) {
  return (
    <div className="order">
      <div className="kv"><span>Auftrag</span><strong>{order.orderNumber ?? order.id}</strong></div>
      {order.orderNumberAtCustomer && <div className="kv"><span>Marktplatz-Nr.</span><span>{order.orderNumberAtCustomer}</span></div>}
      <div className="kv"><span>Datum / Status</span><span>{fmtDate(order.orderDate)} · {order.status ?? "–"}</span></div>
      <h4>Positionen</h4>
      <ul>
        {order.lines.map((l) => <li key={l.id}>{l.quantity} × {l.title} <span className="muted small">(versendet {l.shippedQuantity ?? 0}, retourniert {l.returnedQuantity ?? 0})</span></li>)}
      </ul>
      <h4>Lieferungen ({order.shipments.length})</h4>
      {order.shipments.length === 0 && <p className="muted small">Keine Lieferung in weclapp angelegt.</p>}
      {order.shipments.map((s) => (
        <div key={s.id} className="shipment">
          <div><strong>{s.shipmentNumber ?? s.id}</strong> · ERP-Status {s.erpStatus ?? "–"} {s.erpStatusAt ? `(${fmtDate(s.erpStatusAt)})` : ""}</div>
          <div className="small muted">{s.items.map((i) => `${i.quantity} × ${i.title ?? "?"}`).join(", ")}</div>
          {s.parcels.length === 0 ? (
            <div className="small warn-text">Keine Sendungsnummer hinterlegt.</div>
          ) : (
            <ul>
              {s.parcels.map((p, i) => (
                <li key={p.id ?? i} className="small">
                  Paket {i + 1}: {p.trackingId ?? "ohne Nummer"}{" "}
                  {p.trackingUrl ? <a href={p.trackingUrl} target="_blank" rel="noreferrer noopener">Trackinglink</a> : <span className="muted">kein Link</span>}
                  {p.source === "legacy_package_tracking" && <span className="muted"> (altes Einzelfeld)</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      <p className="muted small">ERP-Status ist eine Buchung in weclapp, kein Scan des Paketdienstes. Ein Trackinglink belegt weder Versand noch Zustellung.</p>
      {order.invoices.length > 0 && (
        <>
          <h4>Rechnungen</h4>
          <ul>{order.invoices.map((inv) => <li key={inv.id} className="small">{inv.invoiceNumber ?? inv.id} · {fmtDate(inv.invoiceDate)} · {inv.paymentStatus ?? inv.status ?? "–"}</li>)}</ul>
        </>
      )}
      <p className="muted small">Abgerufen: {fmtDate(order.retrievedAt)}</p>
    </div>
  );
}

function DraftEditor(props: {
  draft: Draft; canEdit: boolean; approval: CaseData["approvals"][number] | undefined; send: CaseData["send"];
  onSave: (body: string) => void; onApprove: (ack: boolean) => void; onSend: (approvalId: string) => void; onDiscard: () => void; onRedraft: () => void;
}) {
  const { draft, canEdit, approval, send } = props;
  const [body, setBody] = useState(draft.body);
  const [ack, setAck] = useState(false);
  const dirty = body !== draft.body;
  const blocking = draft.issues.filter((i) => i.severity === "block");
  const warnings = draft.issues.filter((i) => i.severity === "warn");
  return (
    <div className="draft">
      <div className="row wrap small">
        <span className="pill muted">{INTENT_LABEL[draft.intent] ?? draft.intent}</span>
        <span className="muted">Version {draft.version} · {draft.generated_by}{draft.ai_model ? ` (${draft.ai_model})` : ""} · {fmtDate(draft.updated_at)}</span>
        {draft.risks.map((r) => <span key={r} className="pill warn">{RISK_LABEL[r] ?? r}</span>)}
      </div>
      {draft.summary && <p className="small"><strong>Zusammenfassung:</strong> {draft.summary}</p>}
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={14} readOnly={!canEdit} />
      {(blocking.length > 0 || warnings.length > 0) && (
        <ul className="issues">
          {blocking.map((i, n) => <li key={`b${n}`} className="error">Blockiert: {i.message}</li>)}
          {warnings.map((i, n) => <li key={`w${n}`} className="warn-text">Hinweis: {i.message}</li>)}
        </ul>
      )}
      {draft.missing_information.length > 0 && <p className="small"><strong>Fehlende Angaben:</strong> {draft.missing_information.join("; ")}</p>}
      {draft.suggested_actions.filter((a) => a !== "none").length > 0 && (
        <p className="small"><strong>Vorgeschlagene nächste Schritte (nur Hinweis, keine automatische Aktion):</strong> {draft.suggested_actions.filter((a) => a !== "none").map((a) => ACTION_LABEL[a] ?? a).join(", ")}</p>
      )}
      <details className="small">
        <summary>Belegte Fakten ({draft.facts.length}), davon zitiert {draft.cited_fact_ids.length}</summary>
        <ul>{draft.facts.map((f) => <li key={f.id} className={draft.cited_fact_ids.includes(f.id) ? "" : "muted"}><code>{f.id}</code> {f.text} <span className="muted">[{f.source}]</span></li>)}</ul>
      </details>
      {canEdit && (
        <div className="row wrap actions">
          <button disabled={!dirty} onClick={() => props.onSave(body)}>Änderungen speichern</button>
          <button onClick={props.onRedraft}>Neu erzeugen</button>
          <button onClick={props.onDiscard}>Verwerfen</button>
          <span className="spacer" />
          {!approval ? (
            <>
              {warnings.length > 0 && <label className="small"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Hinweise geprüft</label>}
              <button className="primary" disabled={dirty || blocking.length > 0 || (warnings.length > 0 && !ack)} onClick={() => props.onApprove(ack)} title={dirty ? "Erst speichern" : undefined}>Freigeben</button>
            </>
          ) : (
            <>
              <span className="pill ok">Freigegeben von {approval.approved_by}, gültig bis {fmtDate(approval.expires_at)}</span>
              <button className="primary" disabled={!send.allowed || dirty} onClick={() => props.onSend(approval.id)}>Senden</button>
            </>
          )}
        </div>
      )}
      {!send.allowed && (
        <div className="notice muted small">
          <strong>Versand derzeit nicht möglich:</strong>
          <ul>{send.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          Der Entwurf kann kopiert und im Postfach manuell gesendet werden; die Kopie in „Gesendete Elemente“ wird dann als „außerhalb gesendet“ erkannt.
        </div>
      )}
    </div>
  );
}

function NoteForm({ onSubmit }: { onSubmit: (body: string) => void }) {
  const [body, setBody] = useState("");
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (body.trim()) { onSubmit(body); setBody(""); } }}>
      <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Interne Notiz" />
      <button type="submit">Notiz speichern</button>
    </form>
  );
}

function CategoryBar({ category, reason, sender, canEdit, onSet }: {
  category: "support" | "info"; reason: string | null; sender: string; canEdit: boolean;
  onSet: (category: "support" | "info", remember: "none" | "address" | "domain") => void;
}) {
  const [asking, setAsking] = useState(false);
  const domain = sender.includes("@") ? sender.slice(sender.lastIndexOf("@") + 1) : "";
  const target = category === "info" ? "support" : "info";
  const choices = (
    <div className="row wrap">
      <button onClick={() => { setAsking(false); onSet(target, "none"); }}>Nur diese Mail</button>
      {sender && <button onClick={() => { setAsking(false); onSet(target, "address"); }}>Alle von {sender}</button>}
      {domain && <button onClick={() => { setAsking(false); onSet(target, "domain"); }}>Alle von @{domain}</button>}
      <button className="link" onClick={() => setAsking(false)}>Abbrechen</button>
    </div>
  );
  if (category === "info") {
    return (
      <div className="notice info-bar">
        <div><strong>Werbung oder Info</strong>, kein Antwortentwurf.{reason ? <span className="muted"> Erkannt an: {reason}.</span> : null}</div>
        {canEdit && (asking ? <><div className="small">Als Kundenanfrage behandeln:</div>{choices}</> : <button onClick={() => setAsking(true)}>Ist eine Kundenanfrage</button>)}
      </div>
    );
  }
  if (!canEdit) return null;
  return asking ? (
    <div className="notice info-bar"><div className="small">Als Werbung/Info einordnen, ohne Antwort:</div>{choices}</div>
  ) : (
    <div className="row"><button className="link" onClick={() => setAsking(true)}>Ist Werbung oder Info, keine Anfrage</button></div>
  );
}
