/**
 * Plausibility check between what the customer says, the title on the order and
 * the article in the ERP. Pack sizes (g, ml, Stück …) and colours are compared;
 * a mismatch is a hint for a person ("mögliche Falschlieferung"), never a verdict.
 */

export interface TitleLine {
  position?: number;
  /** Title on the order position (often the marketplace title from the import). */
  title: string;
  /** Article name in the ERP, when known. */
  articleName?: string;
}

export interface TitleHint {
  kind: "customer_vs_order" | "order_vs_article";
  text: string;
}

const UNIT: Record<string, { unit: string; factor: number }> = {
  mg: { unit: "mg", factor: 1 },
  g: { unit: "g", factor: 1 },
  gr: { unit: "g", factor: 1 },
  gramm: { unit: "g", factor: 1 },
  kg: { unit: "g", factor: 1000 },
  ml: { unit: "ml", factor: 1 },
  cl: { unit: "ml", factor: 10 },
  l: { unit: "ml", factor: 1000 },
  liter: { unit: "ml", factor: 1000 },
  stk: { unit: "Stück", factor: 1 },
  "stück": { unit: "Stück", factor: 1 },
  kps: { unit: "Stück", factor: 1 },
  kapseln: { unit: "Stück", factor: 1 },
  tabletten: { unit: "Stück", factor: 1 },
  tbl: { unit: "Stück", factor: 1 },
};

const SIZE = /(\d+(?:[.,]\d+)?)\s*(mg|kg|gramm|gr|g|ml|cl|liter|l|stk|stück|kps|kapseln|tabletten|tbl)(?![a-zäöüß])/giu;

/** Normalised pack sizes in a text, e.g. "70 g", "1200 ml". */
export function sizesOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(SIZE)) {
    const u = UNIT[m[2]!.toLowerCase()];
    if (!u) continue;
    const value = Math.round(Number(m[1]!.replace(",", ".")) * u.factor * 1000) / 1000;
    out.add(`${String(value).replace(".", ",")} ${u.unit}`);
  }
  return [...out];
}

const COLOURS = ["schwarz", "weiß", "weiss", "grau", "rot", "rosa", "pink", "orange", "gelb", "grün", "blau", "türkis", "lila", "violett", "braun", "beige", "gold", "silber"];

/** Colour words (also inflected: "grüne", "braunen"). */
export function coloursOf(text: string): string[] {
  const lower = text.toLowerCase();
  return COLOURS.filter((c) => new RegExp(`(^|[^a-zäöüß])${c}(e|en|er|es|em)?(?![a-zäöüß])`, "u").test(lower)).map((c) => (c === "weiss" ? "weiß" : c));
}

function list(values: string[]): string {
  return values.join(", ");
}

export function checkTitles(customerText: string, lines: ReadonlyArray<TitleLine>): TitleHint[] {
  const hints: TitleHint[] = [];
  if (lines.length === 0) return hints;
  const orderText = lines.map((l) => `${l.title} ${l.articleName ?? ""}`).join(" ");

  const saidSizes = sizesOf(customerText);
  const orderSizes = sizesOf(orderText);
  const unknownSizes = saidSizes.filter((s) => !orderSizes.includes(s));
  if (orderSizes.length > 0 && unknownSizes.length > 0) {
    hints.push({ kind: "customer_vs_order", text: `Der Kunde nennt ${list(unknownSizes)}, die Bestellung in weclapp enthält ${list(orderSizes)}.` });
  }
  const saidColours = coloursOf(customerText);
  const orderColours = coloursOf(orderText);
  const unknownColours = saidColours.filter((c) => !orderColours.includes(c));
  if (orderColours.length > 0 && unknownColours.length > 0) {
    hints.push({ kind: "customer_vs_order", text: `Der Kunde nennt die Farbe ${list(unknownColours)}, die Bestellung in weclapp enthält ${list(orderColours)}.` });
  }

  lines.forEach((line, i) => {
    if (!line.articleName || line.articleName.trim() === line.title.trim()) return;
    const a = sizesOf(line.title);
    const b = sizesOf(line.articleName);
    const ca = coloursOf(line.title);
    const cb = coloursOf(line.articleName);
    const sizeDiff = a.length > 0 && b.length > 0 && a.join() !== b.join();
    const colourDiff = ca.length > 0 && cb.length > 0 && ca.join() !== cb.join();
    if (sizeDiff || colourDiff) {
      hints.push({ kind: "order_vs_article", text: `Position ${line.position ?? i + 1}: Bestelltitel „${line.title}“, verknüpfter Artikel in weclapp „${line.articleName}“.` });
    }
  });
  return hints;
}
