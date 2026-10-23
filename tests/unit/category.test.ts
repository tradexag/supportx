import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { categorizeMail } from "../../packages/core/category.ts";

const mail = (over: Partial<Parameters<typeof categorizeMail>[0]> = {}) => ({
  from: { address: "kunde@example.invalid" }, subject: "Frage", bodyText: "Hallo", headers: {}, hasOrderReference: false, ...over,
});

describe("request or advertising", () => {
  it("files a marketplace promotion to partners as info", () => {
    const d = categorizeMail(mail({
      from: { address: "marketplace@partner-shop.example.invalid" },
      subject: "Singles Day 2026 – Jetzt für unsere Voucher-Aktionen anmelden!",
      bodyText: "Liebe Marketplace-Partner,\nder Singles Day steht vor der Tür! Die Voucher-Aktionen stehen ab sofort unter Promotions zur Anmeldung bereit.",
    }));
    assert.equal(d.category, "info");
    assert.match(d.reason, /Anrede an Händler/);
  });

  it("files English partner news and bulk mail headers as info", () => {
    assert.equal(categorizeMail(mail({ subject: "Top brands in demand on our marketplace", bodyText: "Dear partner, these brands sell well." })).category, "info");
    assert.equal(categorizeMail(mail({ headers: { "list-unsubscribe": "<https://x.invalid/u>" }, bodyText: "Unser neues Sortiment" })).category, "info");
  });

  it("keeps customer requests, even with promo words or a newsletter footer", () => {
    assert.equal(categorizeMail(mail({ subject: "Wo bleibt meine Bestellung?", bodyText: "Ich habe beim Singles Day bestellt, wann kommt mein Paket?" })).category, "support");
    assert.equal(categorizeMail(mail({ subject: "Rückfrage", bodyText: "Newsletter abbestellen hat nicht geklappt", hasOrderReference: true })).category, "support");
    assert.equal(categorizeMail(mail({ subject: "Produktfrage", bodyText: "Ist das Mittel auch für Kinder geeignet?" })).category, "support");
  });

  it("lets the operator's sender rules win, address before domain", () => {
    const rules = [
      { matchType: "from_domain" as const, pattern: "shop.example.invalid", category: "info" as const },
      { matchType: "from_address" as const, pattern: "support@shop.example.invalid", category: "support" as const },
    ];
    assert.equal(categorizeMail(mail({ from: { address: "news@mail.shop.example.invalid" } }), rules).category, "info");
    const d = categorizeMail(mail({ from: { address: "support@shop.example.invalid" }, bodyText: "Liebe Partner, Webinar" }), rules);
    assert.equal(d.category, "support");
    assert.equal(d.source, "rule");
  });
});
