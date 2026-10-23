import type { AiProvider } from "../core/contracts.ts";
import type { AppConfig } from "../storage/config.ts";
import type { Db } from "../storage/db.ts";
import type { SecretBox } from "../storage/secrets.ts";
import type { ConnectorFactory } from "./connections.ts";

/** Shared by web/API, worker and a future MCP server: one set of services and rules. */
export interface AppContext {
  db: Db;
  config: AppConfig;
  secrets: SecretBox;
  ai: AiProvider;
  /** Claude with a workspace's own key (the installation's key is `ai`). */
  aiWithKey(apiKey: string): AiProvider;
  checkAiKey(apiKey: string): Promise<{ ok: boolean; detail: string }>;
  connectors: ConnectorFactory;
  now(): Date;
}

export type Role = "owner" | "agent" | "viewer";

/** An authenticated caller with a server-verified workspace membership. */
export type Actor =
  | { type: "user"; userId: string; workspaceId: string; role: Role }
  | { type: "worker"; workspaceId: string };

export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
    this.code = code;
  }
}

export function requireRole(actor: Actor, roles: ReadonlyArray<Role>): void {
  if (actor.type === "worker") return;
  if (!roles.includes(actor.role)) throw new ServiceError(403, "FORBIDDEN", "Für diese Aktion fehlt die Berechtigung.");
}

export function actorId(actor: Actor): string | null {
  return actor.type === "user" ? actor.userId : null;
}
