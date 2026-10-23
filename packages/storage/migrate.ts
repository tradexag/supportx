import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Db } from "./db.ts";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/** Apply pending SQL migrations in file-name order, each in its own transaction. */
export async function migrate(db: Db, log: (line: string) => void = () => undefined): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const done: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(4242001)");
      const again = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (again.rowCount === 0) {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        done.push(file);
        log(`Migration angewendet: ${file}`);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error(`Migration ${file} fehlgeschlagen: ${(error as Error).message}`);
    } finally {
      client.release();
    }
  }
  return done;
}
