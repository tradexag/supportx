import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asksForInvoice } from "../../packages/core/invoice-request.ts";

describe("asksForInvoice", () => {
  it("recognises requests for an invoice", () => {
    for (const text of [
      "Bitte Übersenden Sie mir die Rechnung (mit USt) zu meiner Bestellung.",
      "Können Sie mir eine Rechnung schicken?",
      "Ich benötige für meine Firma eine Rechnung.",
      "Wo finde ich die Rechnung zu meiner Bestellung?",
      "Please send me an invoice for my order.",
      "Hätte gern eine Rechnungskopie.",
    ]) assert.equal(asksForInvoice(text), true, text);
  });
  it("leaves complaints and other topics to a person", () => {
    for (const text of [
      "Die Rechnung ist falsch, bitte korrigieren und neu senden.",
      "Bitte die Rechnungsadresse ändern.",
      "Sie haben doppelt abgebucht, ich möchte mein Geld zurück.",
      "Ich habe eine Mahnung bekommen, obwohl ich bezahlt habe.",
      "Wo bleibt mein Paket?",
      "Bitte senden Sie mir einen Ersatz.",
    ]) assert.equal(asksForInvoice(text), false, text);
  });
});
