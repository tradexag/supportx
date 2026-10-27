import { test } from "node:test";
import assert from "node:assert/strict";
import { customerText, shortText } from "../../apps/web/src/customer-text.ts";

const amazonMail = `[Amazon.com]<https://sellercentral.amazon.de/nms/redirect/0d3a?nt=X&sk=Y>

Du hast eine Nachricht erhalten.

Bestellnummer 305-0000000-0000000:

#      ASIN    Produktname
1      B000000000      Demo Zimt gemahlen, 70g
Nachricht:

Ich habe die grüne Dose bestellt. Bekommen habe ich die braune Dose.
Ich bitte um eine Lösung.

Nachricht anzeigen <https://sellercentral.amazon.de/nms/sellermobile/redirect/61dc?nt=X>
Fall lösen <https://sellercentral.amazon.de/nms/redirect/5b97?nt=X>

Copyright 2026 Amazon Inc.`;

test("Amazon: only the buyer's words, without frame and links", () => {
  assert.equal(customerText(amazonMail), "Ich habe die grüne Dose bestellt. Bekommen habe ich die braune Dose.\nIch bitte um eine Lösung.");
});

test("other platforms: the text itself, bare links removed", () => {
  assert.equal(customerText("Wo bleibt mein Paket?\n\nhttps://example.invalid/track?id=1\n"), "Wo bleibt mein Paket?");
});

test("shortText cuts at a word and marks the cut", () => {
  assert.equal(shortText("kurz"), "kurz");
  const long = shortText("wort ".repeat(100), 40);
  assert.ok(long.length <= 42 && long.endsWith(" …"));
});
