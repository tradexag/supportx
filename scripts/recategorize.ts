import { loadConfig } from "../packages/storage/config.ts";
import { createPool } from "../packages/storage/db.ts";
import { loadDotEnv } from "../packages/storage/env.ts";
import { recategorizeAutoCases } from "../packages/services/ingestion.ts";

/** One-off after an update: sort automatically filed cases again (request vs. advertising). */
loadDotEnv();
const db = createPool(loadConfig().DATABASE_URL);
const result = await recategorizeAutoCases(db);
console.log(`Geprüft: ${result.checked} Fälle, davon als Werbung/Info eingeordnet: ${result.info}.`);
await db.end();
