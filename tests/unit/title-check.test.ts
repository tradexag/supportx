import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkTitles, coloursOf, sizesOf } from "../../packages/core/title-check.ts";

describe("title check", () => {
  it("normalises pack sizes and colours", () => {
    assert.deepEqual(sizesOf("Zimt 60g SD-Dose, auch 0,5 l und 1,2 kg"), ["60 g", "500 ml", "1200 g"]);
    assert.deepEqual(sizesOf("40x40 Kissen, 60 Kps."), ["60 Stück"]);
    assert.deepEqual(coloursOf("die grüne Dose, nicht die braune"), ["grün", "braun"]);
    assert.deepEqual(coloursOf("Grünkohl"), []);
  });

  it("flags a pack size the customer names that is not in the order (the cinnamon case)", () => {
    const hints = checkTitles(
      "Ich habe die grüne Dose Zimt bestellt (70g). Bekommen habe ich die braune Dose (60g).",
      [{ position: 1, title: "Herbaria Zimt gemahlen bio* 60g SD-Dose" }],
    );
    assert.equal(hints.length, 1);
    assert.match(hints[0]!.text, /nennt 70 g.*enthält 60 g/);
  });

  it("flags an order title that differs from the linked article, and stays quiet when all fits", () => {
    const hints = checkTitles("Wo bleibt mein Paket?", [{ title: "Zimt 70 g grüne Dose", articleName: "Zimt 60 g SD-Dose" }]);
    assert.deepEqual(hints.map((h) => h.kind), ["order_vs_article"]);
    assert.deepEqual(checkTitles("Meine Dose 60g ist noch nicht da", [{ title: "Zimt 60g SD-Dose", articleName: "Zimt 60g SD-Dose" }]), []);
    assert.deepEqual(checkTitles("Kaputt angekommen", []), []);
  });
});
