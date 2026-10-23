import { loadDotEnv } from "../../packages/storage/env.ts";
import { loadConfig } from "../../packages/storage/config.ts";
import { migrate } from "../../packages/storage/migrate.ts";
import { createContext } from "../../packages/services/bootstrap.ts";
import { drainJobs, scheduleTick } from "../../packages/services/worker.ts";

loadDotEnv();
const config = loadConfig();
const ctx = createContext(config);
const log = (line: string) => console.log(`[worker] ${new Date().toISOString()} ${line}`);

await migrate(ctx.db, log);
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
