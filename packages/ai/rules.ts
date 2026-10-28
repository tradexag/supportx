import type { AiProvider, AllowedFact, CaseRisk, Proposal, ProposalInput, SuggestedAction } from "../core/contracts.ts";
import { classifyIntentByRules, detectRisks } from "../core/classify.ts";

/**
 * Deterministic, model-free provider. It fulfils the same AiProvider contract,
 * so an installation can run without any AI vendor (and the demo works without
 * an API key). Its drafts are fixed German templates filled only with facts.
 */
export class RulesProvider implements AiProvider {
  readonly id = "rules";
  readonly model = "rules";
  readonly promptVersion = "rules.v1";

  async propose(input: ProposalInput): Promise<Proposal> {
    const latest = [...input.messages].reverse().find((m) => m.direction === "inbound")?.text ?? "";
    const intent = classifyIntentByRules(latest);
    const risks: CaseRisk[] = detectRisks(latest);
    const cited: string[] = [];
    const missing: string[] = [];
    const actions: SuggestedAction[] = [];
    const fact = (id: string): AllowedFact | undefined => {
      const f = input.facts.find((x) => x.id === id);
      if (f) cited.push(id);
      return f;
    };
    const lines: string[] = ["Guten Tag,", ""];
    const unique = input.orderStatus === "unique";

    if (risks.includes("health")) {
      lines.push("vielen Dank für Ihre Nachricht. Ihre Frage geben wir an unser fachlich qualifiziertes Team weiter, das sich bei Ihnen meldet.");
      lines.push("Bitte wenden Sie sich bei gesundheitlichen Beschwerden direkt an Ihre Ärztin, Ihren Arzt oder Ihre Apotheke.");
      actions.push("escalate");
    } else if (!unique) {
      lines.push("vielen Dank für Ihre Nachricht.");
      lines.push(
        input.orderStatus === "ambiguous"
          ? "Damit wir Ihr Anliegen eindeutig der richtigen Bestellung zuordnen können, nennen Sie uns bitte zusätzlich den bestellten Artikel und das Bestelldatum."
          : "Damit wir Ihr Anliegen der richtigen Bestellung zuordnen können, nennen Sie uns bitte Ihre Bestellnummer.",
      );
      missing.push(input.orderStatus === "ambiguous" ? "Bestellung nicht eindeutig: mehrere passende Aufträge" : "Bestellnummer bzw. passende Bestellung");
      actions.push("ask_customer");
    } else if (input.decision === "customer_right") {
      fact("order");
      lines.push("vielen Dank für Ihre Nachricht und entschuldigen Sie bitte die Unannehmlichkeiten. Sie haben recht, das hätte nicht passieren dürfen.");
      lines.push("Wir kümmern uns umgehend um eine Lösung und melden uns dazu in Kürze bei Ihnen.");
      actions.push(intent === "wrong_item" || intent === "damaged_item" ? "propose_replacement" : "none");
    } else if (input.decision === "customer_wrong") {
      fact("order");
      const items = input.facts.filter((f) => /^line\.\d+$/.test(f.id));
      items.forEach((f) => cited.push(f.id));
      lines.push("vielen Dank für Ihre Nachricht. Wir haben Ihre Bestellung sorgfältig geprüft.");
      if (items.length) {
        lines.push("Laut unserem System umfasst Ihre Bestellung:");
        items.forEach((f) => lines.push(`- ${f.text.replace(/^Position \d+: /, "").replace(/, davon laut ERP versendet: \d+/, "")}`));
      }
      lines.push("Sollten Sie dennoch etwas anderes erhalten haben, senden Sie uns gern ein Foto des Artikels und des Versandetiketts. Dann sehen wir uns das noch einmal genau an.");
    } else if (input.decision === "ask_customer") {
      fact("order");
      lines.push("vielen Dank für Ihre Nachricht. Damit wir Ihnen schnell weiterhelfen können, senden Sie uns bitte ein Foto des erhaltenen Artikels und des Versandetiketts.");
      lines.push("Sobald wir die Fotos haben, melden wir uns mit einer Lösung bei Ihnen.");
      actions.push("ask_customer");
      missing.push("Fotos des Kunden");
    } else if (intent === "parcel_status") {
      lines.push("vielen Dank für Ihre Nachricht. Zu Ihrer Bestellung liegen uns folgende Informationen vor:");
      fact("order");
      if (fact("shipments.none")) {
        lines.push("- Für Ihre Bestellung ist bei uns noch keine Lieferung angelegt. Wir prüfen den Stand und melden uns bei Ihnen.");
        missing.push("Versandstatus: noch keine Lieferung im ERP");
      }
      for (let i = 1; input.facts.some((f) => f.id === `shipment.${i}.status`); i++) {
        const status = fact(`shipment.${i}.status`)!;
        lines.push(`- ${status.text.replace(/ Dies ist eine ERP-Buchung, kein Scan des Paketdienstes\.$/, "").replace(": im ERP ", ": laut unserem System ")}`);
        for (let p = 1; ; p++) {
          const parcel = input.facts.find((f) => f.id === `shipment.${i}.parcel.${p}`);
          if (!parcel) break;
          cited.push(parcel.id);
          const url = /Trackinglink (\S+?)\.?(\s|$)/.exec(parcel.text)?.[1];
          const number = /Sendungsnummer (\S+?)[,.]/.exec(parcel.text)?.[1];
          if (url) lines.push(`  Paket ${p}: Den aktuellen Stand beim Paketdienst sehen Sie unter ${url}`);
          else if (number) lines.push(`  Paket ${p}: Sendungsnummer ${number}`);
        }
        if (fact(`shipment.${i}.no_tracking`)) missing.push(`Keine Sendungsnummer zu Lieferung ${i}`);
      }
      lines.push("", "Ein Zustellstatus des Paketdienstes liegt uns nicht vor. Sollte die Sendung nicht ankommen, melden Sie sich gern erneut bei uns.");
    } else if (intent === "wrong_item" || intent === "damaged_item") {
      fact("order");
      const items = input.facts.filter((f) => /^line\.\d+$/.test(f.id));
      items.forEach((f) => cited.push(f.id));
      lines.push(intent === "wrong_item"
        ? "es tut uns leid, dass Sie nicht den bestellten Artikel erhalten haben."
        : "es tut uns leid, dass Ihre Lieferung beschädigt angekommen ist.");
      if (items.length) {
        lines.push("Laut unserem System umfasst Ihre Bestellung:");
        items.forEach((f) => lines.push(`- ${f.text.replace(/^Position \d+: /, "").replace(/, davon laut ERP versendet: \d+/, "")}`));
      }
      lines.push(intent === "wrong_item"
        ? "Bitte senden Sie uns ein Foto des erhaltenen Artikels und des Versandetiketts. Danach prüfen wir die nächsten Schritte und melden uns bei Ihnen."
        : "Bitte senden Sie uns Fotos der beschädigten Ware und der Verpackung. Danach prüfen wir die nächsten Schritte und melden uns bei Ihnen.");
      actions.push("ask_customer", "propose_replacement");
      missing.push("Fotos des Kunden");
    } else if (intent === "return_request") {
      fact("order");
      lines.push("vielen Dank für Ihre Nachricht. Wir haben Ihren Rücksendewunsch erhalten und prüfen ihn.");
      lines.push("Wir melden uns mit den nächsten Schritten bei Ihnen.");
      actions.push("check_return_label");
    } else if (intent === "invoice") {
      fact("order");
      const invoice = fact("invoice.1");
      lines.push("vielen Dank für Ihre Nachricht.");
      if (invoice) lines.push(`Zu Ihrer Bestellung liegt uns folgende Rechnung vor: ${invoice.text.replace(/, Status: .*$/, ".")} Wir stellen sie Ihnen gern bereit.`);
      else {
        lines.push("Zu Ihrer Bestellung liegt uns noch keine Rechnung vor. Wir prüfen das und melden uns bei Ihnen.");
        missing.push("Rechnung im ERP");
      }
    } else {
      lines.push("vielen Dank für Ihre Nachricht. Wir haben Ihr Anliegen erhalten und melden uns zeitnah bei Ihnen.");
    }
    lines.push("", input.signature);
    return {
      intent,
      language: "de",
      summary: `Regelbasierte Einordnung: ${intent}${risks.length ? `, Risiken: ${risks.join(", ")}` : ""}.`,
      replyText: lines.join("\n"),
      citedFactIds: [...new Set(cited)],
      missingInformation: missing,
      suggestedActions: actions.length ? actions : ["none"],
      risks,
    };
  }
}
