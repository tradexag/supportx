import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectRisks, routeMessage, type RoutingRule } from "../../packages/core/classify.ts";
import type { OrderRecord } from "../../packages/core/contracts.ts";
import { checkDraft, hasBlockingIssue } from "../../packages/core/draft-check.ts";
import { buildOrderFacts } from "../../packages/core/facts.ts";
import { extractOrderReferences } from "../../packages/core/references.ts";

describe("extractOrderReferences", () => {
  it("finds Amazon, eBay and labelled references, ignores bare numbers", () => {
    const refs = extractOrderReferences("Frage zu 302-1234567-7654321", "Tel 0301234567, PLZ 10115. Bestellnummer: DM-2026-000123 und 12-34567-89012", "email");
    assert.deepEqual(refs.map((r) => r.value), ["302-1234567-7654321", "12-34567-89012", "DM-2026-000123"]);
  });
  it("accepts '#1001' after a label but not words without digits", () => {
    assert.deepEqual(extractOrderReferences("Bestellung #1001", "", "shopify").map((r) => r.value), ["1001"]);
    assert.deepEqual(extractOrderReferences("Bestellung Status", "Order details", "shopify"), []);
  });
  it("recognises labelled invoice and parcel numbers and carrier formats", () => {
    const refs = extractOrderReferences(
      "Rechnung RE-9001 fehlt",
      "Meine Sendungsnummer: 0034 0434 1234 5678 9012 ist nicht da. Tracking-Nr. DEMO00012346. Rechnungsnr.: 2026-4711. UPS 1Z999AA10123456784.",
      "email",
    );
    const by = (kind: string) => refs.filter((r) => r.kind === kind).map((r) => r.value);
    assert.deepEqual(by("invoice_number"), ["RE-9001", "2026-4711"]);
    assert.deepEqual(by("tracking_number"), ["00340434123456789012", "DEMO00012346", "1Z999AA10123456784"]);
  });
  it("does not take dates, words or short numbers for invoice or parcel numbers", () => {
    assert.deepEqual(extractOrderReferences("Ihre Rechnung vom 12.10.", "Die Sendung ist unterwegs. Trackingnummer folgt. Paketnummer 123", "email"), []);
  });
});

describe("routeMessage", () => {
  const rules: RoutingRule[] = [
    { id: "a", priority: 10, matchType: "from_domain", pattern: "docmorris-demo.invalid", sourcePlatform: "docmorris", merchantAccountId: "acc-dm" },
    { id: "b", priority: 20, matchType: "subject_contains", pattern: "amazon", sourcePlatform: "amazon", merchantAccountId: "acc-amz" },
  ];
  const fallback = { sourcePlatform: "email" as const, merchantAccountId: null };
  it("uses sender metadata, including subdomains", () => {
    const d = routeMessage({ from: { address: "x@mail.docmorris-demo.invalid" }, to: [], subject: "Hallo" }, rules, fallback);
    assert.equal(d.sourcePlatform, "docmorris");
    assert.equal(d.merchantAccountId, "acc-dm");
  });
  it("does not match look-alike domains", () => {
    const d = routeMessage({ from: { address: "x@evil-docmorris-demo.invalid" }, to: [], subject: "Hallo" }, rules, fallback);
    assert.equal(d.ruleId, null);
  });
});

describe("detectRisks", () => {
  it("flags health, refund and disputed delivery", () => {
    assert.ok(detectRisks("Kann ich das mit meinem Medikament einnehmen?").includes("health"));
    assert.ok(detectRisks("Bitte um Erstattung").includes("refund"));
    assert.ok(detectRisks("Das Paket ist nie angekommen").includes("delivery_disputed"));
  });
});

const order: OrderRecord = {
  provider: "weclapp",
  id: "so-1",
  orderNumber: "AU-1",
  status: "ORDER_CONFIRMATION_PRINTED",
  tags: [],
  lines: [{ id: "l1", title: "Teekanne", quantity: 1 }, { id: "l2", title: "Sieb", quantity: 2 }],
  shipments: [
    {
      id: "sh1", shipmentNumber: "LS-1", erpStatus: "SHIPPED", erpStatusAt: "2026-10-15T09:00:00.000Z", statusHistory: [], items: [{ orderLineId: "l1", title: "Teekanne", quantity: 1 }],
      parcels: [
        { id: "p1", trackingId: "T1", trackingUrl: "https://track.example.invalid/T1", source: "parcels" },
        { id: "p2", trackingId: "T2", trackingUrl: "https://track.example.invalid/T2", source: "parcels" },
      ],
    },
    { id: "sh2", shipmentNumber: "LS-2", erpStatus: "NEW", statusHistory: [], items: [{ orderLineId: "l2", title: "Sieb", quantity: 2 }], parcels: [] },
  ],
  invoices: [],
  retrievedAt: "2026-10-21T08:00:00.000Z",
};

describe("buildOrderFacts", () => {
  it("keeps every parcel and marks missing tracking per shipment", () => {
    const facts = buildOrderFacts(order);
    const ids = facts.map((f) => f.id);
    assert.ok(ids.includes("shipment.1.parcel.1"));
    assert.ok(ids.includes("shipment.1.parcel.2"));
    assert.ok(ids.includes("shipment.2.no_tracking"));
    const parcel = facts.find((f) => f.id === "shipment.1.parcel.1")!;
    assert.match(parcel.text, /Trackinglink allein belegt weder Versand noch Zustellung/);
  });
});

describe("checkDraft", () => {
  const facts = buildOrderFacts(order);
  const base = { citedFactIds: ["order"], facts, order, orderStatus: "unique" as const, allowedLinkPrefixes: [] };
  it("blocks delivery claims without ERP delivery evidence", () => {
    const issues = checkDraft({ ...base, text: "Ihr Paket wurde zugestellt." });
    assert.ok(issues.some((i) => i.code === "DELIVERY_CLAIM_UNSUPPORTED" && i.severity === "block"));
  });
  it("blocks links that are not in the facts or allow-list", () => {
    const issues = checkDraft({ ...base, text: "Siehe https://phish.example.invalid/x" });
    assert.ok(issues.some((i) => i.code === "UNVERIFIED_LINK"));
    assert.ok(!checkDraft({ ...base, text: "Siehe https://track.example.invalid/T1" }).some((i) => i.code === "UNVERIFIED_LINK"));
  });
  it("blocks completed refunds or replacements", () => {
    const issues = checkDraft({ ...base, text: "Wir haben Ihnen 500 Euro erstattet." });
    assert.ok(hasBlockingIssue(issues));
    assert.ok(issues.some((i) => i.code === "COMPLETED_ACTION_CLAIM"));
  });
  it("blocks citations of unknown facts", () => {
    assert.ok(checkDraft({ ...base, citedFactIds: ["shipment.9.status"], text: "Guten Tag" }).some((i) => i.code === "UNKNOWN_FACT"));
  });
  it("does not treat a negated dispatch statement as a claim", () => {
    const noShipment: OrderRecord = { ...order, shipments: [] };
    const issues = checkDraft({ ...base, order: noShipment, facts: buildOrderFacts(noShipment), text: "Ihre Bestellung wurde noch nicht versendet." });
    assert.ok(!issues.some((i) => i.code === "DISPATCH_CLAIM_UNSUPPORTED"));
  });
});
