import { loadConfig } from "../packages/storage/config.ts";
import { createPool } from "../packages/storage/db.ts";
import { loadDotEnv } from "../packages/storage/env.ts";
import { migrate } from "../packages/storage/migrate.ts";

loadDotEnv();
const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const applied = await migrate(db, (line) => console.log(line));
console.log(applied.length ? `Angewendet: ${applied.join(", ")}` : "Schema ist aktuell.");
await db.end();
