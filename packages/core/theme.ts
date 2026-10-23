import { z } from "zod";

/**
 * Per-installation look: product name, logo, colours, fonts, corner radius.
 * Lives in THEME_DIR/theme.json next to its logo and font files, so a customer's
 * design can be swapped without touching the code. Only validated values reach
 * the CSS, so a theme file cannot inject markup or load foreign resources.
 */
const color = z.string().regex(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i, "Farbe als #rrggbb angeben");
const fileName = z.string().regex(/^[\w.-]+\.(svg|png|jpg|jpeg|webp|woff2?|ttf|otf)$/i, "nur ein Dateiname im Theme-Ordner");
const family = z.string().regex(/^[\w ,"'-]+$/, "Schriftname ohne Sonderzeichen");

export const themeSchema = z.object({
  productName: z.string().min(1).max(40).default("SupportX"),
  tagline: z.string().max(80).default("Support-Posteingang für Marktplatz-Händler"),
  logo: fileName.optional(),
  colors: z.object({
    background: color.default("#f8f9fa"),
    surface: color.default("#ffffff"),
    text: color.default("#111111"),
    textSecondary: color.default("#303030"),
    muted: color.default("#6a6e73"),
    soft: color.default("#a4a8ad"),
    line: color.default("#e8e8e8"),
    primary: color.default("#111111"),
    primaryText: color.default("#ffffff"),
    accent: color.default("#d52b1e"),
  }).prefault({}),
  fonts: z.object({
    sans: family.default('"Geist Sans", "Geist", "Helvetica Neue", Arial, sans-serif'),
    mono: family.default('"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace'),
    files: z.array(z.object({ family: z.string().regex(/^[\w -]+$/), file: fileName, weight: z.union([z.number().int().min(100).max(900), z.string().regex(/^\d{3}( \d{3})?$/)]).default(400), style: z.enum(["normal", "italic"]).default("normal") })).max(12).default([]),
  }).prefault({}),
  radius: z.number().min(0).max(24).default(2),
});

export type Theme = z.infer<typeof themeSchema>;

export const DEFAULT_THEME: Theme = themeSchema.parse({});

export function parseTheme(raw: unknown): Theme {
  return themeSchema.parse(raw ?? {});
}

/** CSS that overrides the built-in tokens. `html:root` outranks the bundled `:root` regardless of load order. */
export function themeCss(theme: Theme): string {
  const c = theme.colors;
  const faces = theme.fonts.files
    .map((f) => `@font-face{font-family:"${f.family}";src:url("/theme/${f.file}");font-weight:${f.weight};font-style:${f.style};font-display:swap}`)
    .join("\n");
  return `${faces}
html:root{--bg:${c.background};--card:${c.surface};--text:${c.text};--graphite:${c.textSecondary};--muted:${c.muted};--soft:${c.soft};--line:${c.line};--accent:${c.primary};--primary:${c.primary};--primary-text:${c.primaryText};--signal:${c.accent};--radius:${theme.radius}px;--sans:${theme.fonts.sans};--mono:${theme.fonts.mono}}
`;
}

/** What the browser needs besides the CSS. */
export function publicTheme(theme: Theme) {
  return { productName: theme.productName, tagline: theme.tagline, logoUrl: theme.logo ? `/theme/${theme.logo}` : null };
}
