import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, PLATFORM_LABEL } from "./api.ts";
import { API_MARKETS, MAIL_MARKETS, MARKET_KIND, marketSetup, microsoftSetup, weclappSetup, type ChannelSetup, type StepAction } from "./setup-steps.ts";

type Role = "owner" | "agent" | "viewer";
interface Account { id: string; name: string; platform: string; order_scope_field: string; order_scope_value: string; paused: boolean }
type ChannelKind = "microsoft_graph" | "ebay_messages" | "kaufland_tickets" | "mirakl_inbox";
interface Connection {
  id: string; kind: ChannelKind; display_name: string;
  config: {
    mailbox?: string; tenantId?: string; clientId?: string; ownAddresses?: string[]; pushNotifications?: boolean; graphBaseUrl?: string;
    ruName?: string; sandbox?: boolean; sellerUsername?: string; storefronts?: string[]; baseUrl?: string; shopId?: string;
    backgroundSyncAllowed?: boolean; backgroundSyncEvidence?: string; pollIntervalSec?: number;
  };
  has_secret: boolean; default_merchant_account_id: string | null; default_source_platform: string; send_enabled: boolean; paused: boolean; health: string; last_sync_at: string | null; last_error: string | null;
}
interface Rule { id: string; connection_id: string; priority: number; match_type: string; pattern: string; source_platform: string; merchant_account_name: string | null }
interface Route { id: string; connection_id: string; source_platform: string; evidence_note: string; verified_at: string; verified_by: string | null }
interface Descriptor { platform: string; label: string; transport: string; implementation: string; receive: string; reply: string; accountTestNeeded: string[]; notes: string }
interface SettingsData {
  workspace: { name: string; reply_signature: string; reply_tone: string; allowed_link_prefixes: string[]; ai_enabled: boolean; has_ai_key: boolean; ai_key_hint: string | null; setup_confirmations: Record<string, { at: string; by: string | null }> };
  accounts: Account[]; connections: Connection[]; rules: Rule[]; routes: Route[];
  erp: null | { base_url: string; search_fields: string[]; has_secret: boolean; status: string; last_checked_at: string | null; last_error: string | null };
  categoryRules: Array<{ id: string; match_type: string; pattern: string; category: "support" | "info" }>;
  jobs: Array<{ type: string; status: string; count: number; last_error: string | null }>;
  catalog: Descriptor[]; ai: { provider: string; model: string; promptVersion: string }; sendMode: string; demoMode: boolean;
}

const PLATFORMS = ["email", "amazon", "ebay", "kaufland", "shop_apotheke", "docmorris", "shopify"];
const MATCH_TYPES: Record<string, string> = { from_domain: "Absender-Domain", from_address: "Absender-Adresse", to_address: "Empfänger-Adresse", subject_contains: "Betreff enthält" };
const IMPL_LABEL: Record<string, string> = { implemented: "umgesetzt", via_microsoft_mail: "über Microsoft-Postfach", planned: "geplant" };
const KIND_LABEL: Record<ChannelKind, string> = { microsoft_graph: "Microsoft-Postfach", ebay_messages: "eBay", kaufland_tickets: "Kaufland", mirakl_inbox: "Shop Apotheke" };
const CAP_LABEL: Record<string, string> = { not_implemented: "nicht umgesetzt", documented: "dokumentiert, ungetestet", configured: "umgesetzt, Kontotest offen", verified: "mit Konto geprüft" };

export function Settings({ workspaceId, role }: { workspaceId: string; role: Role }) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ card: string; action: StepAction } | null>(null);
  const base = `/api/w/${workspaceId}`;
  const owner = role === "owner";

  const load = useCallback(async () => {
    try {
      setData(await api<SettingsData>("GET", `${base}/settings`));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [base]);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>, success?: (result: unknown) => string) => {
    setError(null);
    setNotice(null);
    try {
      const result = await fn();
      if (success) setNotice(success(result));
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!data) return <div className="center muted">{error ?? "Lädt …"}</div>;
  const checkResult = (r: unknown) => {
    const res = r as { ok: boolean; detail: string };
    return `${res.ok ? "Verbindung in Ordnung" : "Prüfung fehlgeschlagen"}: ${res.detail}`;
  };

  const mailboxCount = (c: Connection) => (c.kind === "microsoft_graph" ? data.connections.filter((x) => x.kind === "microsoft_graph" && x.config.mailbox === c.config.mailbox).length : 1);
  const closePanel = () => setPanel(null);
  const checkFirst = (kind: string) => {
    const c = data.connections.find((x) => x.kind === kind);
    if (c) void act(() => api("POST", `${base}/connections/${c.id}/check`), checkResult);
  };
  const connectionCard = (c: Connection) => (
    <ConnectionCard
      key={c.id}
      c={c}
      owner={owner}
      duplicate={mailboxCount(c) > 1}
      rules={data.rules.filter((r) => r.connection_id === c.id)}
      routes={data.routes.filter((r) => r.connection_id === c.id)}
      base={base}
      act={act}
      checkResult={checkResult}
    />
  );

  return (
    <div className="settings-scroll"><div className="settings">
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice ok">{notice}</p>}
      {!owner && <p className="notice muted">Nur Inhaber können Einstellungen ändern.</p>}

      <h2 className="settings-title">Anbindungen</h2>
      <p className="muted settings-sub">Jede Karte zeigt, was erledigt ist und was als Nächstes zu tun ist. Ein grüner Innenrand heißt: Nachrichten kommen an. Antworten bleiben Entwürfe, bis ein Antwortweg geprüft und der Versand freigeschaltet ist.</p>

      <SetupCard setup={microsoftSetup(data)} owner={owner} onAction={(a) => a === "check" ? checkFirst("microsoft_graph") : setPanel({ card: "microsoft", action: a })}>
        {data.connections.filter((c) => c.kind === "microsoft_graph").map((c) => connectionCard(c))}
        {owner && panel?.card === "microsoft" && panel.action === "connect" && <GraphForm onCancel={closePanel} onSubmit={(body) => { closePanel(); void act(() => api("POST", `${base}/connections`, body), () => "Postfach verbunden. Die ersten Mails kommen in wenigen Minuten."); }} />}
      </SetupCard>

      <SetupCard setup={weclappSetup(data)} owner={owner} onAction={(a) => a === "check" ? void act(() => api("POST", `${base}/erp/check`), checkResult) : setPanel({ card: "weclapp", action: a })}>
        {data.erp && (
          <div className="facts">
            <div className="kv"><span>Adresse</span><code>{data.erp.base_url}</code></div>
            <div className="kv"><span>Zugang</span><span>{data.erp.has_secret ? "Token hinterlegt" : "Token fehlt"}{data.erp.last_checked_at ? ` · geprüft ${fmtDate(data.erp.last_checked_at)}` : ""}</span></div>
            <div className="kv"><span>Gesucht wird in</span><span>{data.erp.search_fields.join(", ")}</span></div>
          </div>
        )}
        {owner && (panel?.card === "weclapp" || !data.erp) && <ErpForm current={data.erp?.base_url ?? ""} onSubmit={(body) => { closePanel(); void act(() => api("PUT", `${base}/erp`, body), () => "weclapp gespeichert. Bitte einmal „Verbindung testen“."); }} />}
        {owner && data.erp && panel?.card !== "weclapp" && <div className="row"><button onClick={() => setPanel({ card: "weclapp", action: "erp" })}>Adresse oder Token ändern</button></div>}
      </SetupCard>

      <h2 className="settings-title">Marktplätze</h2>
      {[...API_MARKETS, ...MAIL_MARKETS].map((m) => {
        const kind = (API_MARKETS as readonly string[]).includes(m) ? MARKET_KIND[m as (typeof API_MARKETS)[number]] : null;
        const own = kind ? data.connections.filter((c) => c.kind === kind) : [];
        const graph = data.connections.find((c) => c.kind === "microsoft_graph");
        const open = (a: string) => panel?.card === m && panel.action === a;
        const onAction = (a: StepAction) => {
          if (a === "check" && kind) return checkFirst(kind);
          if (a === "confirm" || a === "unconfirm") return void act(() => api("POST", `${base}/setup-confirmations`, { platform: m, done: a === "confirm" }), () => a === "confirm" ? "Abgehakt." : "Haken entfernt.");
          if (a === "ebay_login" && own[0]) return void act(async () => { const r = await api<{ url: string }>("POST", `${base}/connections/${own[0]!.id}/ebay/authorize`); window.location.assign(r.url); });
          setPanel({ card: m, action: a });
        };
        const connectionId = kind ? own[0]?.id : graph?.id;
        return (
          <SetupCard key={m} setup={marketSetup(m, { ...data, confirmations: data.workspace.setup_confirmations })} owner={owner} onAction={onAction} graphMailbox={kind ? undefined : graph?.config.mailbox}>
            {own.map((c) => connectionCard(c))}
            {owner && open("connect") && m === "ebay" && <EbayForm onCancel={closePanel} onSubmit={(body) => { closePanel(); void act(() => api("POST", `${base}/connections/ebay`, body), () => "eBay angelegt. Jetzt „Bei eBay anmelden“ klicken."); }} />}
            {owner && open("connect") && m === "kaufland" && <KauflandForm onCancel={closePanel} onSubmit={(body) => { closePanel(); void act(() => api("POST", `${base}/connections/kaufland`, body), () => "Kaufland verbunden. Bitte einmal „Verbindung testen“."); }} />}
            {owner && open("connect") && m === "shop_apotheke" && <MiraklForm onCancel={closePanel} onSubmit={(body) => { closePanel(); void act(() => api("POST", `${base}/connections/mirakl`, body), () => "Shop Apotheke verbunden. Bitte einmal „Verbindung testen“."); }} />}
            {owner && open("rule") && (graph ? <div className="inset"><p className="muted small">Absender-Domain aus einer echten {PLATFORM_LABEL[m]}-Mail eintragen.</p><RuleForm preset={m} onSubmit={(body) => { closePanel(); void act(() => api("POST", `${base}/connections/${graph.id}/rules`, body), () => "Regel angelegt."); }} /></div> : <p className="notice small">Zuerst das Microsoft-Postfach verbinden.</p>)}
            {owner && open("route") && (connectionId ? <div className="inset"><RouteForm defaultPlatform={m} onSubmit={(body) => { closePanel(); void act(() => api("POST", `${base}/connections/${connectionId}/routes`, body), () => "Antwortweg als geprüft vermerkt."); }} /></div> : <p className="notice small">Zuerst die Verbindung anlegen.</p>)}
          </SetupCard>
        );
      })}

      <h2 className="settings-title">Weitere Einstellungen</h2>
      <section className="card">
        <h3>Werbung erkennen</h3>
        <p className="muted">Newsletter, Aktionen und Partner-Infos erkennt SupportX selbst und legt sie unter „Werbung &amp; Infos“ ab, ohne Antwortentwurf. Liegt es einmal daneben, im Fall umschalten und dabei „Alle von …“ wählen. Das merkt sich SupportX hier.</p>
        {data.categoryRules.length === 0 ? <p className="small muted">Noch keine eigenen Absender-Regeln.</p> : (
          <table>
            <thead><tr><th>Absender</th><th>immer als</th><th /></tr></thead>
            <tbody>{data.categoryRules.map((r) => (
              <tr key={r.id}>
                <td><code>{r.match_type === "from_domain" ? `@${r.pattern}` : r.pattern}</code></td>
                <td>{r.category === "info" ? "Werbung/Info" : "Kundenanfrage"}</td>
                <td>{owner && <button className="link" onClick={() => act(() => api("DELETE", `${base}/category-rules/${r.id}`), () => "Regel entfernt.")}>entfernen</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <WorkspaceForm data={data} owner={owner} onSave={(body) => act(() => api("PUT", `${base}/settings`, body), () => "Gespeichert.")} />

      <AiKeyCard
        data={data}
        owner={owner}
        onSave={(apiKey) => act(() => api("POST", `${base}/ai-key`, { apiKey }), () => (apiKey ? "Schlüssel geprüft und gespeichert. Neue Entwürfe schreibt jetzt Claude." : "Eigener Schlüssel entfernt."))}
        onCheck={() => act(() => api("POST", `${base}/ai-key/check`), checkResult)}
      />

      <PasswordForm onSubmit={(body) => act(() => api("POST", "/api/password", body), () => "Passwort geändert. Andere angemeldete Geräte sind abgemeldet.")} />

      <details className="card wide">
        <summary><h3>Technik und Stand der Kanäle</h3></summary>
        <div className="kv"><span>Versand</span><strong>{data.sendMode === "enabled" ? "möglich, je Postfach freizuschalten" : "aus, nur Entwürfe"}</strong></div>
        <div className="kv"><span>KI</span><span>{data.ai.provider} · {data.ai.model} · Prompt {data.ai.promptVersion}</span></div>
        {data.jobs.length > 0 && (
          <>
            <h4>Hintergrundaufgaben</h4>
            <ul>{data.jobs.map((j) => <li key={`${j.type}${j.status}`} className="small">{JOB_LABEL[j.type] ?? j.type}: {j.count} × {JOB_STATUS[j.status] ?? j.status}{j.last_error ? ` – ${j.last_error}` : ""}</li>)}</ul>
          </>
        )}
        <h4>Kanäle</h4>
        <table>
          <thead><tr><th>Kanal</th><th>Weg</th><th>Status</th><th>Empfang</th><th>Antwort</th><th>Offene Kontotests</th></tr></thead>
          <tbody>
            {data.catalog.map((d) => (
              <tr key={d.platform}>
                <td><strong>{d.label}</strong><div className="muted small">{d.notes}</div></td>
                <td className="small">{d.transport}</td>
                <td>{IMPL_LABEL[d.implementation] ?? d.implementation}</td>
                <td className="small">{CAP_LABEL[d.receive] ?? d.receive}</td>
                <td className="small">{CAP_LABEL[d.reply] ?? d.reply}</td>
                <td className="small"><ul>{d.accountTestNeeded.map((t) => <li key={t}>{t}</li>)}</ul></td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <p className="small muted credit">SupportX ist Open Source (MIT), ein Produkt von <a href="https://aseio.app" target="_blank" rel="noopener">ASEIO</a> · TradeX International AG</p>
    </div></div>
  );
}

function SetupCard({ setup, owner, onAction, graphMailbox, children }: {
  setup: ChannelSetup; owner: boolean; onAction: (a: StepAction) => void; graphMailbox?: string; children?: React.ReactNode;
}) {
  const doneCount = setup.steps.filter((s) => s.done).length;
  const countable = setup.steps.length;
  const pill = setup.error ? { cls: "pill bad", label: "Fehler" } : setup.connected ? { cls: "pill ok", label: "Angebunden" } : doneCount === 0 ? { cls: "pill muted", label: "Nicht eingerichtet" } : { cls: "pill warn", label: `${doneCount} von ${countable} erledigt` };
  const ACTION_LABEL: Record<StepAction, string> = { connect: "Jetzt eintragen", ebay_login: "Bei eBay anmelden", check: "Verbindung testen", rule: "Regel anlegen", route: "Antwortweg vermerken", erp: "Jetzt eintragen", confirm: "Erledigt, abhaken", unconfirm: "Haken entfernen" };
  return (
    <section className={`card setup${setup.connected && !setup.error ? " connected" : ""}`} aria-label={setup.label}>
      <div className="setup-head">
        <div>
          <h3 className="setup-name">{setup.label}</h3>
          <div className="muted small">{setup.way}{graphMailbox ? ` · ${graphMailbox}` : ""}</div>
        </div>
        <span className={pill.cls}>{pill.label}</span>
      </div>
      {setup.error && <p className="notice bad small">{explainError(setup.error)}</p>}
      {setup.next ? (
        <div className="next-step">
          <div><span className="next-label">Als Nächstes</span><strong>{setup.next.title}</strong>{setup.next.hint && <div className="muted small">{setup.next.hint}</div>}</div>
          {owner && setup.next.action && <button className="primary" onClick={() => onAction(setup.next!.action!)}>{ACTION_LABEL[setup.next.action]}</button>}
        </div>
      ) : (
        <p className="done-line small">Alles eingerichtet.</p>
      )}
      <ol className="steps">
        {setup.steps.map((s, i) => (
          <li key={s.key} className={s.done ? "done" : s.external ? "external" : s === setup.next ? "current" : ""}>
            <span className="mark" aria-hidden="true">{s.done ? "✓" : s.external ? "→" : i + 1}</span>
            <span className="step-body">
              <span className="step-title">{s.title}{s.external && <span className="tag"> · dort erledigen</span>}{s.done && <span className="sr-only"> (erledigt)</span>}</span>
              {s.hint && s !== setup.next && (!s.done || s.external) && <span className="muted small">{s.hint}</span>}
            </span>
            {owner && (!s.done || s.action === "unconfirm") && s.action && s !== setup.next && <button className="link" onClick={() => onAction(s.action!)}>{ACTION_LABEL[s.action]}</button>}
          </li>
        ))}
      </ol>
      {children}
    </section>
  );
}

const JOB_LABEL: Record<string, string> = { "mail.sync": "Mails abrufen", "case.enrich": "Bestellung suchen", "case.draft": "Entwurf schreiben", "outbox.dispatch": "Versand", "outbox.reconcile": "Versand bestätigen", "mail.subscription": "Benachrichtigung erneuern" };
const JOB_STATUS: Record<string, string> = { queued: "wartet", running: "läuft", failed: "fehlgeschlagen" };

/** Turns raw provider errors into a sentence that says what to do. */
function explainError(raw: string): string {
  if (/AADSTS7000215|invalid client secret/i.test(raw)) return "Der geheime Schlüssel ist falsch. Unter „Schlüssel austauschen“ den „Wert“ aus Entra eintragen (nicht die „Geheime ID“).";
  if (/AADSTS7000222|expired/i.test(raw)) return "Der geheime Schlüssel ist abgelaufen. In Entra einen neuen anlegen und unter „Schlüssel austauschen“ eintragen.";
  if (/AADSTS700016/i.test(raw)) return "Die Anwendungs-ID passt nicht zum Microsoft-Mandanten.";
  if (/AADSTS90002/i.test(raw)) return "Die Verzeichnis-ID (Mandant) ist unbekannt.";
  if (/403|Access ?Denied|ErrorAccessDenied/i.test(raw)) return "Microsoft verweigert den Zugriff auf dieses Postfach. Der Exchange-Admin muss die Freigabe für genau dieses Postfach einrichten.";
  return raw;
}

function ConnectionCard({ c, owner, duplicate, rules, routes, base, act, checkResult }: {
  c: Connection; owner: boolean; duplicate: boolean; rules: Rule[]; routes: Route[]; base: string;
  act: (fn: () => Promise<unknown>, success?: (result: unknown) => string) => Promise<void>; checkResult: (r: unknown) => string;
}) {
  const [secretOpen, setSecretOpen] = useState(false);
  const status = c.paused ? { label: "Pausiert", cls: "pill warn" } : c.health === "ok" ? { label: "Verbunden", cls: "pill ok" } : c.health === "error" ? { label: "Fehler", cls: "pill bad" } : { label: "Noch nicht geprüft", cls: "pill muted" };
  const graph = c.kind === "microsoft_graph";
  const where = graph ? `im Microsoft-Postfach` : `bei ${KIND_LABEL[c.kind]}`;
  const ident = graph ? c.config.mailbox : c.kind === "ebay_messages" ? c.config.sellerUsername ?? "noch nicht angemeldet" : c.kind === "mirakl_inbox" ? c.config.baseUrl : c.config.storefronts?.length ? `Storefronts ${c.config.storefronts.join(", ")}` : "alle Storefronts";
  const ebayLogin = () => act(async () => { const r = await api<{ url: string }>("POST", `${base}/connections/${c.id}/ebay/authorize`); window.location.assign(r.url); });
  const remove = () => {
    if (!window.confirm(`Verbindung „${c.display_name}“ (${ident}) löschen?\n\nAlle Fälle, die über diese Verbindung geholt wurden, werden in SupportX mitgelöscht. ${where.charAt(0).toUpperCase() + where.slice(1)} bleibt alles unverändert.`)) return;
    void act(() => api("DELETE", `${base}/connections/${c.id}`), (r) => `Verbindung gelöscht${(r as { deletedCases: number }).deletedCases ? `, ${(r as { deletedCases: number }).deletedCases} Fälle entfernt` : ""}.`);
  };
  return (
    <div className="connection">
      <div className="conn-head">
        <div>
          <div className="row wrap"><strong className="conn-name">{c.display_name}</strong><span className="pill muted">{KIND_LABEL[c.kind] ?? c.kind}</span><span className={status.cls}>{status.label}</span></div>
          <div className="muted small"><code>{ident}</code> · Letzter Abruf: {c.last_sync_at ? fmtDate(c.last_sync_at) : "noch nie"} · {c.send_enabled ? "Versand freigeschaltet" : "nur Entwürfe"}</div>
        </div>
        {owner && (
          <div className="row wrap">
            {c.kind === "ebay_messages" && !c.config.sellerUsername ? <button className="primary" onClick={ebayLogin}>Bei eBay anmelden</button> : <button className="primary" disabled={c.paused} onClick={() => act(() => api("POST", `${base}/connections/${c.id}/sync`), () => "Abruf gestartet. Neue Mails erscheinen in wenigen Minuten im Posteingang.")}>Jetzt abrufen</button>}
            <button onClick={() => act(() => api("POST", `${base}/connections/${c.id}/check`), checkResult)}>Verbindung testen</button>
          </div>
        )}
      </div>
      {duplicate && <p className="notice warn small">Dieses Postfach ist mehrfach verbunden, dadurch kommt jede Mail doppelt an. Behalte eine Verbindung, die anderen löschen.</p>}
      {c.kind === "mirakl_inbox" && !c.config.backgroundSyncAllowed && <p className="notice small">Shop Apotheke wird nur per Klick auf „Jetzt abrufen“ gelesen, bis der Betreiber einen Hintergrundabruf erlaubt (siehe Erweitert).</p>}
      {c.last_error && !c.paused && <p className="notice bad small">{explainError(c.last_error)}</p>}
      {owner && (
        <div className="row wrap">
          {graph && <button onClick={() => setSecretOpen(!secretOpen)}>Schlüssel austauschen</button>}
          {c.kind === "ebay_messages" && c.config.sellerUsername && <button onClick={ebayLogin}>Bei eBay neu anmelden</button>}
          <button onClick={() => act(() => api("POST", `${base}/connections/${c.id}/paused`, { paused: !c.paused }))}>{c.paused ? "Fortsetzen" : "Pausieren"}</button>
          <button className="danger" onClick={remove}>Löschen</button>
        </div>
      )}
      {secretOpen && owner && <SecretForm onSubmit={(clientSecret) => { setSecretOpen(false); void act(() => api("POST", `${base}/connections/${c.id}/secret`, { clientSecret }), () => "Schlüssel ausgetauscht. Bitte einmal „Verbindung testen“."); }} />}
      <details className="more">
        <summary>Erweitert: {graph ? "Zuordnung, " : ""}Antwortwege, technische Angaben</summary>
        {c.kind === "mirakl_inbox" && owner && (<>
          <h4>Hintergrundabruf</h4>
          <p className="muted small">Mirakl sieht das Lesen der Nachrichten nur beim Öffnen des Posteingangs vor. Erst wenn Shop Apotheke einen regelmäßigen Abruf erlaubt hat, hier mit Nachweis eintragen.</p>
          <MiraklBackgroundForm connection={c} onSubmit={(body) => act(() => api("POST", `${base}/connections/${c.id}/mirakl-background-sync`, body), () => "Gespeichert.")} />
        </>)}
        {graph && (<>
        <h4>Zuordnungsregeln</h4>
        <p className="muted small">Ordnen Mails anhand von Absender, Empfänger oder Betreff einer Plattform zu, nie anhand des Textes. Ohne Treffer gilt: {PLATFORM_LABEL[c.default_source_platform]}.</p>
        {rules.length > 0 && (
          <table>
            <thead><tr><th>Prio</th><th>Regel</th><th>Plattform</th><th /></tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>{r.priority}</td><td>{MATCH_TYPES[r.match_type]}: <code>{r.pattern}</code></td><td>{PLATFORM_LABEL[r.source_platform]}</td>
                  <td>{owner && <button className="link" onClick={() => act(() => api("DELETE", `${base}/rules/${r.id}`))}>entfernen</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {owner && <RuleForm onSubmit={(body) => act(() => api("POST", `${base}/connections/${c.id}/rules`, body), () => "Regel angelegt.")} />}
        </>)}
        <h4>Antwortwege und Versand</h4>
        <p className="muted small">Bevor SupportX verschicken darf, je Plattform einmal an einer echten Nachricht prüfen: Absender, Reply-To, Zuordnung und eine Testantwort, die beim Kunden bzw. im Marktplatz ankommt.</p>
        {routes.length === 0 && <p className="small">Noch kein Antwortweg geprüft, der Versand bleibt gesperrt.</p>}
        <ul>
          {routes.map((r) => (
            <li key={r.id} className="small">
              <strong>{PLATFORM_LABEL[r.source_platform]}</strong> geprüft {fmtDate(r.verified_at)} von {r.verified_by ?? "?"}: {r.evidence_note}{" "}
              {owner && <button className="link" onClick={() => act(() => api("DELETE", `${base}/connections/${c.id}/routes/${r.source_platform}`))}>zurückziehen</button>}
            </li>
          ))}
        </ul>
        {owner && <RouteForm defaultPlatform={graph ? "docmorris" : c.default_source_platform} onSubmit={(body) => act(() => api("POST", `${base}/connections/${c.id}/routes`, body), () => "Antwortweg als geprüft vermerkt.")} />}
        {owner && <button onClick={() => { if (!c.send_enabled && !window.confirm("Versand für diese Verbindung freischalten? Danach können freigegebene Antworten wirklich an Kunden gehen.")) return; void act(() => api("POST", `${base}/connections/${c.id}/send-enabled`, { enabled: !c.send_enabled })); }}>{c.send_enabled ? "Versand sperren" : "Versand freischalten"}</button>}
        <h4>Technische Angaben</h4>
        <p className="muted small">Zugangsdaten bleiben verborgen. Die IDs lassen sich bei Bedarf einblenden, Schlüssel nie.</p>
        {graph && <HiddenValue label="Verzeichnis-ID" value={c.config.tenantId} />}
        {(graph || c.kind === "ebay_messages") && <HiddenValue label="Anwendungs-ID" value={c.config.clientId} suffix={c.config.sandbox ? " (Sandbox)" : ""} />}
        {c.kind === "ebay_messages" && <HiddenValue label="RuName" value={c.config.ruName} />}
        {c.kind === "mirakl_inbox" && c.config.shopId && <HiddenValue label="Shop-ID" value={c.config.shopId} />}
        <div className="kv small"><span>Schlüssel</span><span>{c.has_secret ? "gespeichert (verschlüsselt)" : "fehlt"}</span></div>
        {c.config.pollIntervalSec ? <div className="kv small"><span>Abruf</span><span>höchstens alle {Math.round(c.config.pollIntervalSec / 60)} Minuten</span></div> : null}
        {c.config.graphBaseUrl && <div className="kv small"><span>Testendpunkt</span><code>{c.config.graphBaseUrl}</code></div>}
      </details>
    </div>
  );
}

/** Stored access data is hidden by default; only an explicit click shows it. */
function HiddenValue({ label, value, suffix = "" }: { label: string; value?: string; suffix?: string }) {
  const [show, setShow] = useState(false);
  if (!value) return null;
  return (
    <div className="kv small">
      <span>{label}</span>
      <span>{show ? <code>{value}{suffix}</code> : <span>gespeichert{suffix}</span>} <button type="button" className="link" onClick={() => setShow(!show)}>{show ? "verbergen" : "anzeigen"}</button></span>
    </div>
  );
}

function SecretField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [show, setShow] = useState(false);
  const v = value.trim();
  const looksLikeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  return (
    <label>
      Geheimer Clientschlüssel
      <div className="row"><input type={show ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} required autoComplete="off" spellCheck={false} /><button type="button" onClick={() => setShow(!show)}>{show ? "verbergen" : "anzeigen"}</button></div>
      <span className={looksLikeId ? "error small" : "muted small"}>
        {looksLikeId ? "Das ist die „Geheime ID“. Gebraucht wird die Spalte „Wert“ daneben." : v ? `Beginnt mit ${v.slice(0, 3)}…, ${v.length} Zeichen. In Entra steht er als „${v.slice(0, 3)}***“.` : "In Entra unter „Zertifikate & Geheimnisse“ die Spalte „Wert“ kopieren, nicht „Geheime ID“."}
      </span>
    </label>
  );
}

function SecretForm({ onSubmit }: { onSubmit: (secret: string) => void }) {
  const [secret, setSecret] = useState("");
  return (
    <form className="stack inset" onSubmit={(e) => { e.preventDefault(); onSubmit(secret); }}>
      <SecretField value={secret} onChange={setSecret} />
      <div className="row"><button type="submit" className="primary">Schlüssel speichern</button></div>
    </form>
  );
}

function PasswordForm({ onSubmit }: { onSubmit: (body: { oldPassword: string; newPassword: string }) => Promise<void> }) {
  const [oldPassword, setOld] = useState("");
  const [newPassword, setNew] = useState("");
  const [repeat, setRepeat] = useState("");
  const mismatch = repeat !== "" && repeat !== newPassword;
  return (
    <section className="card">
      <h3>Mein Passwort</h3>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); if (mismatch) return; await onSubmit({ oldPassword, newPassword }); setOld(""); setNew(""); setRepeat(""); }}>
        <label>Bisheriges Passwort<input type="password" value={oldPassword} onChange={(e) => setOld(e.target.value)} autoComplete="current-password" required /></label>
        <label>Neues Passwort (mindestens 10 Zeichen)<input type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} autoComplete="new-password" minLength={10} required /></label>
        <label>Neues Passwort wiederholen<input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required /></label>
        {mismatch && <p className="error">Die beiden neuen Passwörter sind nicht gleich.</p>}
        <div className="row"><button type="submit" className="primary" disabled={mismatch}>Passwort ändern</button></div>
      </form>
    </section>
  );
}

function AiKeyCard({ data, owner, onSave, onCheck }: { data: SettingsData; owner: boolean; onSave: (apiKey: string | null) => Promise<void>; onCheck: () => Promise<void> }) {
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState(false);
  const ws = data.workspace;
  const serverClaude = data.ai.provider === "claude";
  const state = !ws.ai_enabled ? "Aus: Entwürfe kommen aus Regelvorlagen." : ws.has_ai_key ? "Claude mit eigenem Schlüssel (gespeichert)." : serverClaude ? "Claude mit dem Schlüssel dieser Installation." : "Kein Claude-Schlüssel: Entwürfe kommen aus Regelvorlagen.";
  return (
    <section className="card">
      <h3>KI für Antwortentwürfe</h3>
      <p className="muted">{state}</p>
      <p className="muted">Die Zuordnung zu Bestellungen läuft immer ohne KI. Claude formuliert nur den Entwurf, und jeder Entwurf wird vor dem Versand von einem Menschen geprüft.</p>
      {owner && ws.has_ai_key && !editing && (
        <div className="row">
          <button type="button" onClick={() => setEditing(true)}>Schlüssel ändern</button>
          <button type="button" onClick={() => void onCheck()}>Schlüssel testen</button>
          <button type="button" onClick={() => { if (window.confirm("Eigenen Claude-Schlüssel entfernen?")) void onSave(null); }}>Entfernen</button>
        </div>
      )}
      {owner && (!ws.has_ai_key || editing) && (
        <form className="stack" onSubmit={async (e) => { e.preventDefault(); await onSave(key); setKey(""); setEditing(false); }}>
          <label>Eigener Claude-API-Schlüssel (aus console.anthropic.com, beginnt mit „sk-ant-“)
            <div className="row"><input type={show ? "text" : "password"} value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} placeholder={ws.has_ai_key ? "neuen Schlüssel eintragen, um ihn zu ersetzen" : "sk-ant-…"} required /><button type="button" onClick={() => setShow(!show)}>{show ? "verbergen" : "anzeigen"}</button></div>
          </label>
          <div className="row">
            <button type="submit" className="primary">Prüfen und speichern</button>
            {editing && <button type="button" onClick={() => { setKey(""); setEditing(false); }}>Abbrechen</button>}
          </div>
        </form>
      )}
      <p className="muted small">Der Schlüssel wird verschlüsselt gespeichert und nie wieder angezeigt. Kosten rechnet Anthropic direkt mit dem Inhaber des Schlüssels ab. Gilt für alle neuen Entwürfe dieses Arbeitsbereichs.</p>
    </section>
  );
}

function WorkspaceForm({ data, owner, onSave }: { data: SettingsData; owner: boolean; onSave: (body: unknown) => void }) {
  const [signature, setSignature] = useState(data.workspace.reply_signature);
  const [tone, setTone] = useState(data.workspace.reply_tone);
  const [links, setLinks] = useState(data.workspace.allowed_link_prefixes.join("\n"));
  const [aiEnabled, setAiEnabled] = useState(data.workspace.ai_enabled);
  return (
    <section className="card">
      <h3>Antworten</h3>
      <label>Signatur<textarea rows={3} value={signature} onChange={(e) => setSignature(e.target.value)} disabled={!owner} /></label>
      <label>Tonalität<input value={tone} onChange={(e) => setTone(e.target.value)} disabled={!owner} /></label>
      <label>Freigegebene Link-Anfänge (je Zeile, z. B. Retourenportal)<textarea rows={3} value={links} onChange={(e) => setLinks(e.target.value)} disabled={!owner} /></label>
      <label className="row"><input type="checkbox" checked={aiEnabled} onChange={(e) => setAiEnabled(e.target.checked)} disabled={!owner} /> KI-Entwürfe verwenden (sonst Regelvorlagen)</label>
      {owner && <button onClick={() => onSave({ replySignature: signature, replyTone: tone, allowedLinkPrefixes: links.split("\n").map((l) => l.trim()).filter(Boolean), aiEnabled })}>Speichern</button>}
    </section>
  );
}

function ErpForm({ current, onSubmit }: { current: string; onSubmit: (body: unknown) => void }) {
  const [baseUrl, setBaseUrl] = useState(current);
  const [token, setToken] = useState("");
  return (
    <form className="row wrap" onSubmit={(e) => { e.preventDefault(); onSubmit({ baseUrl, ...(token ? { apiToken: token } : {}) }); setToken(""); }}>
      <input placeholder="https://<mandant>.weclapp.com/webapp/api/v2" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required size={40} />
      <input type="password" placeholder={current ? "Token (leer = unverändert)" : "API-Token"} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
      <button type="submit">weclapp speichern</button>
    </form>
  );
}

function RuleForm({ onSubmit, preset }: { onSubmit: (body: unknown) => void; preset?: string }) {
  const [matchType, setMatchType] = useState("from_domain");
  const [pattern, setPattern] = useState("");
  const [platform, setPlatform] = useState(preset ?? "docmorris");
  return (
    <form className="row wrap" onSubmit={(e) => { e.preventDefault(); onSubmit({ matchType, pattern, sourcePlatform: platform, merchantAccountId: null, priority: 10 }); setPattern(""); }}>
      <select value={matchType} onChange={(e) => setMatchType(e.target.value)}>{Object.entries(MATCH_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <input placeholder="Muster, z. B. absender-domain.example" value={pattern} onChange={(e) => setPattern(e.target.value)} required />
      <select value={platform} onChange={(e) => setPlatform(e.target.value)}>{PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}</select>
      <button type="submit">Regel hinzufügen</button>
    </form>
  );
}

function RouteForm({ defaultPlatform, onSubmit }: { defaultPlatform: string; onSubmit: (body: unknown) => void }) {
  const [platform, setPlatform] = useState(defaultPlatform);
  const [note, setNote] = useState("");
  return (
    <form className="row wrap" onSubmit={(e) => { e.preventDefault(); onSubmit({ sourcePlatform: platform, evidenceNote: note }); setNote(""); }}>
      <select value={platform} onChange={(e) => setPlatform(e.target.value)}>{PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}</select>
      <input placeholder="Nachweis: Datum, Nachricht, Absender/Reply-To, Ergebnis der Testantwort" value={note} onChange={(e) => setNote(e.target.value)} required minLength={10} size={50} />
      <button type="submit">Antwortweg als geprüft vermerken</button>
    </form>
  );
}

function GraphForm({ onSubmit, onCancel }: { onSubmit: (body: unknown) => void; onCancel: () => void }) {
  const [form, setForm] = useState({ displayName: "", tenantId: "", clientId: "", clientSecret: "", mailbox: "", ownAddresses: "", defaultSourcePlatform: "email" });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  return (
    <form
      className="stack inset"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ ...form, ownAddresses: form.ownAddresses.split(/[\s,]+/).filter(Boolean) });
      }}
    >
      <h4>Postfach verbinden</h4>
      <p className="muted small">Die Angaben stehen in Entra bei der App unter „Übersicht“ und „Zertifikate &amp; Geheimnisse“. Der Exchange-Admin muss den Zugriff vorher auf genau dieses Postfach beschränkt haben.</p>
      <label>Name<input placeholder="z. B. Kundenservice" value={form.displayName} onChange={set("displayName")} required /></label>
      <label>Postfach<input placeholder="service@firma.de" value={form.mailbox} onChange={set("mailbox")} required /></label>
      <label>Verzeichnis-ID (Mandant)<input placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={form.tenantId} onChange={set("tenantId")} required /></label>
      <label>Anwendungs-ID (Client)<input placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={form.clientId} onChange={set("clientId")} required /></label>
      <SecretField value={form.clientSecret} onChange={(v) => setForm({ ...form, clientSecret: v })} />
      <details className="more">
        <summary>Optional</summary>
        <label>Weitere eigene Absenderadressen (mit Komma)<input value={form.ownAddresses} onChange={set("ownAddresses")} /></label>
        <label>Plattform, wenn keine Regel passt<select value={form.defaultSourcePlatform} onChange={set("defaultSourcePlatform")}>{PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}</select></label>
      </details>
      <div className="row"><button type="submit" className="primary">Verbinden</button><button type="button" onClick={onCancel}>Abbrechen</button></div>
    </form>
  );
}

function HiddenField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <label>{label}<input type="password" value={value} onChange={(e) => onChange(e.target.value)} required autoComplete="off" spellCheck={false} /></label>;
}

function EbayForm({ onSubmit, onCancel }: { onSubmit: (body: unknown) => void; onCancel: () => void }) {
  const [form, setForm] = useState({ displayName: "eBay", clientId: "", clientSecret: "", ruName: "", sandbox: false });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  return (
    <form className="stack inset" onSubmit={(e) => { e.preventDefault(); onSubmit({ ...form, clientSecret: form.clientSecret.trim() });  }}>
      <h4>eBay verbinden</h4>
      <p className="muted small">Die Angaben stehen im eBay Developer Program unter „Application Keys“ (Production). Beim RuName als „Auth accepted URL“ eintragen: <code>{window.location.origin}/oauth/ebay/callback</code>. Danach mit dem Verkäuferkonto „Bei eBay anmelden“.</p>
      <label>Name<input value={form.displayName} onChange={set("displayName")} required /></label>
      <label>App ID (Client ID)<input value={form.clientId} onChange={set("clientId")} required autoComplete="off" /></label>
      <HiddenField label="Cert ID (Client Secret)" value={form.clientSecret} onChange={(v) => setForm({ ...form, clientSecret: v })} />
      <label>RuName<input value={form.ruName} onChange={set("ruName")} required autoComplete="off" /></label>
      <label className="row"><input type="checkbox" checked={form.sandbox} onChange={(e) => setForm({ ...form, sandbox: e.target.checked })} /> Sandbox (nur zum Ausprobieren)</label>
      <div className="row"><button type="submit" className="primary">Anlegen</button><button type="button" onClick={onCancel}>Abbrechen</button></div>
    </form>
  );
}

function KauflandForm({ onSubmit, onCancel }: { onSubmit: (body: unknown) => void; onCancel: () => void }) {
  const [form, setForm] = useState({ displayName: "Kaufland", clientKey: "", secretKey: "", storefronts: "" });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  return (
    <form className="stack inset" onSubmit={(e) => { e.preventDefault(); onSubmit({ ...form, clientKey: form.clientKey.trim(), secretKey: form.secretKey.trim(), storefronts: form.storefronts.split(/[\s,]+/).filter(Boolean) });  }}>
      <h4>Kaufland verbinden</h4>
      <p className="muted small">Die Schlüssel stehen im Kaufland Seller Portal unter Einstellungen → API. Bestehende Schlüssel einfach kopieren, nicht neu erzeugen, sonst hören andere Programme damit auf. Tickets werden höchstens alle 5 Minuten abgefragt.</p>
      <label>Name<input value={form.displayName} onChange={set("displayName")} required /></label>
      <label>Client Key<input value={form.clientKey} onChange={set("clientKey")} required autoComplete="off" spellCheck={false} /></label>
      <HiddenField label="Secret Key" value={form.secretKey} onChange={(v) => setForm({ ...form, secretKey: v })} />
      <label>Storefronts (leer = alle, z. B. de)<input value={form.storefronts} onChange={set("storefronts")} /></label>
      <div className="row"><button type="submit" className="primary">Verbinden</button><button type="button" onClick={onCancel}>Abbrechen</button></div>
    </form>
  );
}

function MiraklForm({ onSubmit, onCancel }: { onSubmit: (body: unknown) => void; onCancel: () => void }) {
  const [form, setForm] = useState({ displayName: "Shop Apotheke", baseUrl: "", apiKey: "", shopId: "" });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  return (
    <form className="stack inset" onSubmit={(e) => { e.preventDefault(); onSubmit({ ...form, apiKey: form.apiKey.trim(), shopId: form.shopId.trim() || undefined });  }}>
      <h4>Shop Apotheke verbinden</h4>
      <p className="muted small">Shop Apotheke läuft auf Mirakl. Adresse und API-Schlüssel stehen im Mirakl-Backoffice oben rechts unter dem Benutzer → API-Schlüssel. Gelesen wird zunächst nur per Klick auf „Jetzt abrufen“.</p>
      <label>Name<input value={form.displayName} onChange={set("displayName")} required /></label>
      <label>Adresse der Instanz<input placeholder="https://….mirakl.net" value={form.baseUrl} onChange={set("baseUrl")} required /></label>
      <HiddenField label="API-Schlüssel" value={form.apiKey} onChange={(v) => setForm({ ...form, apiKey: v })} />
      <label>Shop-ID (nur bei mehreren Shops)<input value={form.shopId} onChange={set("shopId")} /></label>
      <div className="row"><button type="submit" className="primary">Verbinden</button><button type="button" onClick={onCancel}>Abbrechen</button></div>
    </form>
  );
}

function MiraklBackgroundForm({ connection, onSubmit }: { connection: Connection; onSubmit: (body: unknown) => void }) {
  const [note, setNote] = useState("");
  if (connection.config.backgroundSyncAllowed) {
    return (
      <p className="small">Erlaubt: {connection.config.backgroundSyncEvidence}{" "}
        <button className="link" onClick={() => onSubmit({ allowed: false })}>wieder ausschalten</button>
      </p>
    );
  }
  return (
    <form className="row wrap" onSubmit={(e) => { e.preventDefault(); onSubmit({ allowed: true, evidenceNote: note }); setNote(""); }}>
      <input placeholder="Nachweis: wer bei Shop Apotheke es erlaubt hat, wann, wo festgehalten" value={note} onChange={(e) => setNote(e.target.value)} required minLength={10} size={50} />
      <button type="submit">Hintergrundabruf erlauben</button>
    </form>
  );
}
