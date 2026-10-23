import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Queryable } from "./db.ts";

/**
 * Connector credentials are encrypted at rest with AES-256-GCM. The key comes
 * from the deployment (APP_ENCRYPTION_KEY), never from the database or browser.
 * Values are referenced by opaque ids and never returned by the HTTP API.
 */
export class SecretBox {
  readonly #key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, "base64");
    if (key.length !== 32) throw new Error("APP_ENCRYPTION_KEY muss 32 Byte (base64-kodiert) lang sein.");
    this.#key = key;
  }

  async store(q: Queryable, workspaceId: string, purpose: string, plaintext: string): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(`${workspaceId}:${purpose}`));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const result = await q.query<{ id: string }>(
      "INSERT INTO secrets (workspace_id, purpose, ciphertext, iv, auth_tag) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [workspaceId, purpose, ciphertext, iv, cipher.getAuthTag()],
    );
    return result.rows[0]!.id;
  }

  /** Workspace-scoped read: a secret id from another workspace yields nothing. */
  async read(q: Queryable, workspaceId: string, secretId: string): Promise<string> {
    const result = await q.query<{ purpose: string; ciphertext: Buffer; iv: Buffer; auth_tag: Buffer }>(
      "SELECT purpose, ciphertext, iv, auth_tag FROM secrets WHERE workspace_id = $1 AND id = $2",
      [workspaceId, secretId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Zugangsdaten nicht gefunden.");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, row.iv);
    decipher.setAAD(Buffer.from(`${workspaceId}:${row.purpose}`));
    decipher.setAuthTag(row.auth_tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
  }
}
