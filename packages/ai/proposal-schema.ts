import { z } from "zod";
import type { Proposal } from "../core/contracts.ts";

export const INTENTS = ["parcel_status", "wrong_item", "damaged_item", "return_request", "invoice", "product_question", "other"] as const;
export const RISKS = ["health", "legal", "refund", "replacement", "cancellation", "delivery_disputed", "identity_uncertain", "abusive", "other"] as const;
export const ACTIONS = ["none", "ask_customer", "check_return_label", "propose_replacement", "propose_refund", "escalate"] as const;

/** Runtime validation of any provider output. Types alone are not a trust boundary. */
export const proposalSchema = z.object({
  intent: z.enum(INTENTS),
  language: z.string().min(2).max(10),
  summary: z.string().max(600),
  replyText: z.string().min(1).max(6000),
  citedFactIds: z.array(z.string().max(80)).max(40),
  missingInformation: z.array(z.string().max(300)).max(10),
  suggestedActions: z.array(z.enum(ACTIONS)).max(6),
  risks: z.array(z.enum(RISKS)).max(9),
});

export function parseProposal(value: unknown): Proposal {
  return proposalSchema.parse(value);
}

/** JSON schema for structured outputs (closed objects, all fields required). */
export const proposalJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "language", "summary", "replyText", "citedFactIds", "missingInformation", "suggestedActions", "risks"],
  properties: {
    intent: { type: "string", enum: [...INTENTS] },
    language: { type: "string", description: "ISO 639-1 language of the customer, e.g. de" },
    summary: { type: "string", description: "One or two sentences for the support agent, in German" },
    replyText: { type: "string", description: "Reply to the customer in the customer's language, including greeting and the given signature" },
    citedFactIds: { type: "array", items: { type: "string" } },
    missingInformation: { type: "array", items: { type: "string" } },
    suggestedActions: { type: "array", items: { type: "string", enum: [...ACTIONS] } },
    risks: { type: "array", items: { type: "string", enum: [...RISKS] } },
  },
} as const;
