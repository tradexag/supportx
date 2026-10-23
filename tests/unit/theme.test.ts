import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_THEME, parseTheme, publicTheme, themeCss } from "../../packages/core/theme.ts";

describe("installation theme", () => {
  it("fills missing values from the default look", () => {
    const t = parseTheme({ productName: "Kundenservice", colors: { primary: "#2f6b2a" } });
    assert.equal(t.colors.primary, "#2f6b2a");
    assert.equal(t.colors.background, DEFAULT_THEME.colors.background);
    assert.match(themeCss(t), /html:root\{[^}]*--primary:#2f6b2a/);
    assert.deepEqual(publicTheme(t), { productName: "Kundenservice", tagline: DEFAULT_THEME.tagline, logoUrl: null });
  });

  it("refuses values that could inject CSS or load foreign files", () => {
    assert.throws(() => parseTheme({ colors: { text: "red;}body{display:none" } }));
    assert.throws(() => parseTheme({ logo: "../../etc/passwd.png" }));
    assert.throws(() => parseTheme({ logo: "https://evil.invalid/x.svg" }));
    assert.throws(() => parseTheme({ fonts: { sans: "x;}*{background:url(https://evil.invalid)}" } }));
  });

  it("serves own font files from the theme folder only", () => {
    const css = themeCss(parseTheme({ fonts: { files: [{ family: "Brand Sans", file: "brand.woff2", weight: 600 }] } }));
    assert.match(css, /@font-face\{font-family:"Brand Sans";src:url\("\/theme\/brand\.woff2"\);font-weight:600/);
  });
});
