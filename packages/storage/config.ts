import { z } from "zod";

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_ENCRYPTION_KEY: z.string().min(1, "APP_ENCRYPTION_KEY fehlt (32 Byte, base64)"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  SECURE_COOKIES: bool.default(false),
  AI_PROVIDER: z.enum(["claude", "rules"]).default("rules"),
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
  CLAUDE_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  CLAUDE_MAX_TOKENS: z.coerce.number().int().positive().default(16000),
  CLAUDE_REFUSAL_FALLBACK: z.enum(["default", "off"]).default("default"),
  SEND_MODE: z.enum(["drafts_only", "enabled"]).default("drafts_only"),
  DEMO_MODE: bool.default(false),
  ALLOW_TEST_ENDPOINTS: bool.default(false),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
  MAIL_SYNC_INTERVAL_SEC: z.coerce.number().int().positive().default(60),
  APPROVAL_TTL_MIN: z.coerce.number().int().positive().default(240),
  // Folder with theme.json plus logo and font files for this installation's look (optional).
  THEME_DIR: z.string().optional(),
  // eBay Marketplace Account Deletion: the verification token entered in the eBay developer portal (32–80 of A-Z a-z 0-9 _ -).
  EBAY_DELETION_VERIFICATION_TOKEN: z.string().regex(/^[A-Za-z0-9_-]{32,80}$/, "32–80 Zeichen, nur Buchstaben, Ziffern, _ und -").optional(),
});

export type AppConfig = z.infer<typeof schema>;

/** Read configuration from the environment. Secrets never come from the browser. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Ungültige Konfiguration:\n${lines.join("\n")}`);
  }
  const config = parsed.data;
  if (config.AI_PROVIDER === "claude" && !config.ANTHROPIC_API_KEY) {
    throw new Error("AI_PROVIDER=claude benötigt ANTHROPIC_API_KEY.");
  }
  return config;
}
