/**
 * The customer's own words inside a marketplace message, without the
 * marketplace's frame (links, footer, legal text). Pure; used by the case view and the export.
 * Amazon's buyer-seller mails wrap the text in "Nachricht:" … "Nachricht anzeigen <…>"
 * (English: "Message:" … "View message"). Everything else is returned without
 * bare link blocks. Display only: the full message stays visible below.
 */
const AMAZON = /(?:^|\n)\s*(?:Nachricht|Message)\s*:\s*\n([\s\S]*?)\n\s*(?:Nachricht anzeigen|View message|Fall lösen|Resolve case)\b/i;

export function customerText(body: string): string {
  const amazon = AMAZON.exec(body);
  const text = amazon ? amazon[1]! : body;
  return text
    .replace(/<https?:\/\/[^>\s]*>/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** First sentences of the customer text, at most `max` characters, cut at a word. */
export function shortText(text: string, max = 280): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max * 0.6))} …`;
}
