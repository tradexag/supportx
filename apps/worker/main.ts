import { loadDotEnv } from "../../packages/storage/env.ts";
import { loadConfig } from "../../packages/storage/config.ts";
import { migrate } from "../../packages/storage/migrate.ts";
import { createContext } from "../../packages/services/bootstrap.ts";
import { drainJobs, scheduleTick } from "../../packages/services/worker.ts";
import { mergeSplitFollowUps } from "../../packages/services/ingestion.ts";

loadDotEnv();
const config = loadConfig();
const ctx = createContext(config);
const log = (line: string) => console.log(`[worker] ${new Date().toISOString()} ${line}`);

await migrate(ctx.db, log);
// Follow-up mails that became their own case before they were recognised.
const merged = await mergeSplitFollowUps(ctx.db).catch((error: Error) => (log(`Zusammenführen fehlgeschlagen: ${error.message}`), 0));
if (merged > 0) log(`${merged} Folgemail-Fälle mit dem früheren Fall zusammengeführt.`);
log(`gestartet. KI: ${ctx.ai.id} (${ctx.ai.model}), Versandmodus: ${config.SEND_MODE}${config.DEMO_MODE ? ", DEMO-MODUS" : ""}`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    log("wird beendet …");
  });
}

let lastTick = 0;
while (!stopping) {
  try {
    if (Date.now() - lastTick > 5_000) {
      await scheduleTick(ctx);
      lastTick = Date.now();
    }
    const processed = await drainJobs(ctx, { maxJobs: 50, log });
    if (processed === 0) await new Promise((r) => setTimeout(r, config.WORKER_POLL_MS));
  } catch (error) {
    log(`Fehler in der Arbeitsschleife: ${(error as Error).message}`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
}
await ctx.db.end();
