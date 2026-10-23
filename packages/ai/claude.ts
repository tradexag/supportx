import Anthropic from "@anthropic-ai/sdk";
import type { AiProvider, Proposal, ProposalInput } from "../core/contracts.ts";
import { parseProposal, proposalJsonSchema } from "./proposal-schema.ts";
import { PROMPT_VERSION, renderCaseInput, SYSTEM_PROMPT } from "./prompt.ts";

export interface ClaudeConfig {
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens: number;
  /** Server-side refusal fallback ("default" lets the API pick the fallback model). */
  refusalFallback: "default" | "off";
  baseURL?: string;
  timeoutMs?: number;
}

export class AiProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "AiProviderError";
    this.retryable = retryable;
  }
}

/**
 * Claude behind the provider-neutral AiProvider contract. The model receives a
 * bounded case context and returns a structured proposal; it gets no tools, no
 * credentials and no recipient or route information.
 */
export class ClaudeProvider implements AiProvider {
  readonly id = "claude";
  readonly model: string;
  readonly promptVersion = PROMPT_VERSION;
  readonly #client: Anthropic;
  readonly #config: ClaudeConfig;

  constructor(config: ClaudeConfig) {
    this.#config = config;
    this.model = config.model;
    this.#client = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: config.timeoutMs ?? 120_000, maxRetries: 2 });
  }

  async propose(input: ProposalInput): Promise<Proposal> {
    let response;
    try {
      response = await this.#client.beta.messages.create({
        model: this.#config.model,
        max_tokens: this.#config.maxTokens,
        thinking: { type: "adaptive" },
        output_config: { effort: this.#config.effort, format: { type: "json_schema", schema: proposalJsonSchema } },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: renderCaseInput(input) }],
        ...(this.#config.refusalFallback === "default"
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
      });
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError || error instanceof Anthropic.APIConnectionError) {
        throw new AiProviderError(`Claude vorübergehend nicht erreichbar: ${error.message}`, true);
      }
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        throw new AiProviderError("Claude-Zugang abgelehnt. API-Schlüssel prüfen.", false);
      }
      if (error instanceof Anthropic.APIError) throw new AiProviderError(`Claude-Fehler ${error.status}: ${error.message}`, false);
      throw new AiProviderError((error as Error).message, true);
    }
    if (response.stop_reason === "refusal") {
      throw new AiProviderError("Claude hat die Anfrage abgelehnt. Bitte manuell bearbeiten.", false);
    }
    if (response.stop_reason === "max_tokens") {
      throw new AiProviderError("Claude-Antwort abgeschnitten (max_tokens). CLAUDE_MAX_TOKENS erhöhen.", false);
    }
    const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    try {
      return parseProposal(JSON.parse(text));
    } catch (error) {
      throw new AiProviderError(`Claude-Antwort entspricht nicht dem Schema: ${(error as Error).message.slice(0, 300)}`, true);
    }
  }
}

/**
 * Checks a key without spending tokens: reading the configured model's metadata
 * needs a valid key with access to that model.
 */
export async function checkClaudeKey(apiKey: string, model: string, opts: { baseURL?: string; timeoutMs?: number } = {}): Promise<{ ok: boolean; detail: string }> {
  const client = new Anthropic({ apiKey, baseURL: opts.baseURL, timeout: opts.timeoutMs ?? 20_000, maxRetries: 1 });
  try {
    const info = await client.models.retrieve(model);
    return { ok: true, detail: `Schlüssel gültig, Modell ${info.display_name ?? model} erreichbar.` };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) return { ok: false, detail: "Schlüssel ungültig oder widerrufen." };
    if (error instanceof Anthropic.PermissionDeniedError) return { ok: false, detail: "Schlüssel hat keinen Zugriff auf dieses Modell." };
    if (error instanceof Anthropic.NotFoundError) return { ok: false, detail: `Modell ${model} ist mit diesem Schlüssel nicht verfügbar.` };
    if (error instanceof Anthropic.APIError) return { ok: false, detail: `Claude-Fehler ${error.status ?? ""}`.trim() };
    return { ok: false, detail: "Claude nicht erreichbar. Bitte später erneut testen." };
  }
}
