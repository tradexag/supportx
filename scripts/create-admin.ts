import { parseArgs } from "node:util";
import { loadConfig } from "../packages/storage/config.ts";
import { createPool, one, withTx } from "../packages/storage/db.ts";
import { loadDotEnv } from "../packages/storage/env.ts";
import { migrate } from "../packages/storage/migrate.ts";
import { createUser } from "../packages/services/auth.ts";

/**
 * Creates the first owner and workspace:
 *   npm run admin:create -- --email you@example.com --name "Ihr Name" --workspace "Firma GmbH"
 * Adds another owner to an existing workspace (e.g. the managing director of the customer):
 *   npm run admin:create -- --email gf@example.com --name "Name" --workspace-id <uuid>
 * The password is read from SUPPORTX_ADMIN_PASSWORD (min. 10 characters) so it does not land in shell history.
 */
loadDotEnv();
const { values } = parseArgs({ options: { email: { type: "string" }, name: { type: "string" }, workspace: { type: "string" }, "workspace-id": { type: "string" } } });
const password = process.env.SUPPORTX_ADMIN_PASSWORD ?? "";
const joinId = values["workspace-id"];
if (!values.email || (!values.workspace && !joinId) || password.length < 10) {
  console.error('Aufruf: SUPPORTX_ADMIN_PASSWORD=... npm run admin:create -- --email <mail> --name "<Name>" (--workspace "<Firma>" | --workspace-id <id>)');
  process.exit(1);
}
const db = createPool(loadConfig().DATABASE_URL);
await migrate(db);
await withTx(db, async (tx) => {
  const existing = await one<{ id: string }>(tx, "SELECT id FROM users WHERE email = $1", [values.email!.toLowerCase()]);
  const userId = existing?.id ?? (await createUser(tx, { email: values.email!, displayName: values.name ?? values.email!, password }));
  if (joinId) {
    const ws = await one<{ id: string; name: string }>(tx, "SELECT id, name FROM workspaces WHERE id = $1", [joinId]);
    if (!ws) throw new Error(`Arbeitsbereich ${joinId} gibt es nicht.`);
    await tx.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'owner'", [ws.id, userId]);
    console.log(`${values.email} ist jetzt Inhaber im Arbeitsbereich "${ws.name}".`);
    return;
  }
  const ws = await one<{ id: string }>(tx, "INSERT INTO workspaces (name) VALUES ($1) RETURNING id", [values.workspace]);
  await tx.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [ws!.id, userId]);
  console.log(`Arbeitsbereich "${values.workspace}" (${ws!.id}) mit Inhaber ${values.email} angelegt.`);
});
await db.end();
