import type { AiProvider } from "../core/contracts.ts";
import type { AppConfig } from "../storage/config.ts";
import { ClaudeProvider } from "./claude.ts";
import { RulesProvider } from "./rules.ts";

export { AiProviderError } from "./claude.ts";

/** Claude with the given key and the installation's model settings. */
export function claudeWithKey(config: AppConfig, apiKey: string): AiProvider {
  return new ClaudeProvider({
    apiKey,
    model: config.CLAUDE_MODEL,
    effort: config.CLAUDE_EFFORT,
    maxTokens: config.CLAUDE_MAX_TOKENS,
    refusalFallback: config.CLAUDE_REFUSAL_FALLBACK,
  });
}

/** Provider selection is server configuration; business rules do not depend on it. */
export function createAiProvider(config: AppConfig): AiProvider {
  if (config.AI_PROVIDER === "claude") return claudeWithKey(config, config.ANTHROPIC_API_KEY!);
  return new RulesProvider();
}

export { checkClaudeKey } from "./claude.ts";
