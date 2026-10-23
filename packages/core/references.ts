import type { ReferenceQuery, SourcePlatform } from "./contracts.ts";

export interface OrderReference {
  value: string;
  /** How it was recognised; a labelled or platform-format match, never free guessing. */
  kind: "amazon_order_id" | "ebay_order_id" | "labelled" | "invoice_number" | "tracking_number";
  foundIn: "subject" | "body";
}

const AMAZON = /\b(\d{3}-\d{7}-\d{7})\b/g;
const EBAY = /\b(\d{2}-\d{5}-\d{5})\b/g;
// A reference must follow an explicit label. Bare numbers (phone, postcode) are ignored.
const LABELLED =
  /(?:bestell(?:ung|nummer|-?nr\.?)|auftrag(?:snummer|s-?nr\.?)?|order(?:\s*(?:id|number|no\.?|nr\.?))?|vorgang(?:snummer)?)\s*(?:[:#]|nr\.?|nummer)?\s*#?\s*([A-Z0-9][A-Z0-9_/-]{3,39})/gi;

// Invoice and parcel numbers also need a label, except for carrier formats that cannot be anything else.
const INVOICE =
  /(?<![a-zäöüß])(?:rechnungs?(?:nummer|-?nr\.?)?|re-?nr\.?|invoice(?:\s*(?:number|no\.?|nr\.?))?)\s*(?:[:#]|nr\.?|nummer)?\s*#?\s*([A-Z0-9][A-Z0-9_/-]{3,39})/gi;
const TRACKING =
  /(?<![a-zäöüß])(?:sendungs(?:verfolgungs)?(?:nummer|-?nr\.?)|paket(?:nummer|-?nr\.?)|tracking(?:\s*-?\s*(?:nummer|number|id|nr\.?|code))?)\s*(?:[:#]|nr\.?|nummer)?\s*#?\s*([A-Z0-9]{2,40}(?: \d{2,6}){0,8})/gi;
const CARRIER_FORMATS = [/\b(00340\d{15})\b/g, /\b(JJD\d{16,18})\b/g, /\b(1Z[0-9A-Z]{16})\b/g];

const STOP_WORDS = new Set(["status", "nummer", "number", "bestaetigung", "bestätigung", "confirmation", "details"]);

function collect(text: string, foundIn: OrderReference["foundIn"], platform: SourcePlatform, out: Map<string, OrderReference>): void {
  for (const match of text.matchAll(AMAZON)) {
    const value = match[1]!;
    if (!out.has(value)) out.set(value, { value, kind: "amazon_order_id", foundIn });
  }
  if (platform === "ebay" || platform === "email") {
    for (const match of text.matchAll(EBAY)) {
      const value = match[1]!;
      if (!out.has(value)) out.set(value, { value, kind: "ebay_order_id", foundIn });
    }
  }
  for (const match of text.matchAll(INVOICE)) {
    const value = match[1]!.replace(/[-/_.]+$/, "");
    if (value.length < 4 || !/\d/.test(value)) continue;
    if (!out.has(value)) out.set(value, { value, kind: "invoice_number", foundIn });
  }
  for (const match of text.matchAll(TRACKING)) {
    const value = match[1]!.replace(/ /g, "");
    if (value.length < 8 || !/\d/.test(value)) continue;
    if (!out.has(value)) out.set(value, { value, kind: "tracking_number", foundIn });
  }
  for (const pattern of CARRIER_FORMATS) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1]!;
      if (!out.has(value)) out.set(value, { value, kind: "tracking_number", foundIn });
    }
  }
  for (const match of text.matchAll(LABELLED)) {
    const value = match[1]!.replace(/[-/_.]+$/, "");
    if (value.length < 4 || STOP_WORDS.has(value.toLowerCase()) || !/\d/.test(value)) continue;
    if (!out.has(value)) out.set(value, { value, kind: "labelled", foundIn });
  }
}

/**
 * Extract candidate order references from a customer message. The result is a
 * list of candidates for an exact ERP lookup, not a match. Quoted earlier replies
 * are included in the body on purpose: the customer often only quotes the number.
 */
export function extractOrderReferences(subject: string, body: string, platform: SourcePlatform): OrderReference[] {
  const out = new Map<string, OrderReference>();
  collect(subject, "subject", platform, out);
  collect(body.slice(0, 20_000), "body", platform, out);
  return [...out.values()].slice(0, 10);
}

/** What the ERP lookup searches for: order numbers in orders, invoice numbers in invoices, parcel numbers in shipments. */
export function toReferenceQuery(reference: OrderReference): ReferenceQuery {
  if (reference.kind === "invoice_number") return { value: reference.value, kind: "invoice" };
  if (reference.kind === "tracking_number") return { value: reference.value, kind: "tracking" };
  return { value: reference.value, kind: "order" };
}
