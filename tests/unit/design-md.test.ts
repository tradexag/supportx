import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkTheme, contrast, readDesignMd } from "../../packages/core/design-md.ts";

const SAMPLE = `# Design-Basis

## Farben
| Token | Wert | Rolle |
| --- | --- | --- |
| \`--paper\` | #ffffff | Hintergrund der Seite |
| \`--ink\` | #111111 | Text |
| \`--graphite\` | #303030 | Nebentext |
| \`--ink-muted\` | #6a6e73 | Hinweise und Captions |
| \`--hairline\` | #e8e8e8 | Linien und Rahmen |
| \`--brand\` | #6D33D6 | Akzent |
| \`--danger\` | #b3261e | Fehler |
| Text auf Ink | #ffffff | on dark |

## Typografie
Schrift: **Geist**, Code in **JetBrains Mono**.

## Ecken
Radius für Karten und Knöpfe:
- 2px überall
`;

describe("readDesignMd", () => {
  it("takes colours by role, fonts and radius from prose, and skips status colours", () => {
    const r = readDesignMd(SAMPLE);
    assert.equal(r.theme.colors.background, "#ffffff");
    assert.equal(r.theme.colors.text, "#111111");
    assert.equal(r.theme.colors.textSecondary, "#303030");
    assert.equal(r.theme.colors.muted, "#6a6e73");
    assert.equal(r.theme.colors.line, "#e8e8e8");
    assert.equal(r.theme.colors.accent, "#6d33d6");
    assert.ok(!Object.values(r.theme.colors).includes("#b3261e"), "the error colour is not part of the base look");
    assert.match(r.theme.fonts.sans ?? "", /^"Geist"/);
    assert.match(r.theme.fonts.mono ?? "", /JetBrains Mono/);
    assert.equal(r.theme.radius, 2);
    assert.deepEqual(r.warnings, []);
  });

  it("prefers a JSON block in theme.json form", () => {
    const r = readDesignMd('Text\n```json\n{"productName":"Muster Support","colors":{"primary":"#1e5a2b"},"radius":6}\n```\nHintergrund: #ffffff');
    assert.equal(r.theme.productName, "Muster Support");
    assert.equal(r.theme.colors.primary, "#1e5a2b");
    assert.equal(r.theme.colors.primaryText, "#ffffff", "a readable text colour for the button is picked");
    assert.equal(r.theme.radius, 6);
  });

  it("drops unreadable colour pairs with a reason", () => {
    const r = readDesignMd("Hintergrund: #ffffff\nText: #eeeeee");
    assert.equal(r.theme.colors.text, undefined);
    assert.equal(r.theme.colors.background, undefined);
    assert.match(r.warnings.join(" "), /schlecht lesbar/);
  });

  it("says so when nothing was found and never takes external links", () => {
    const r = readDesignMd("# Nur Text\n@import url(https://fonts.googleapis.com/css?family=X);");
    assert.equal(r.found.length, 0);
    assert.match(r.warnings.join(" "), /keine Farben/);
    assert.match(r.warnings.join(" "), /Externe Schriftdateien/);
  });

  it("rejects values that could break out of the CSS", () => {
    assert.throws(() => checkTheme({ colors: { text: "red;}body{display:none" }, fonts: {} }));
    assert.throws(() => checkTheme({ colors: {}, fonts: { sans: "X;}body{display:none" } }));
    assert.equal(Math.round(contrast("#ffffff", "#000000")), 21);
  });
});
