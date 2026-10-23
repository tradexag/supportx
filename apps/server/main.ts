import { loadDotEnv } from "../../packages/storage/env.ts";
import { loadConfig } from "../../packages/storage/config.ts";
import { migrate } from "../../packages/storage/migrate.ts";
import { createContext } from "../../packages/services/bootstrap.ts";
import { buildServer } from "./app.ts";

loadDotEnv();
const config = loadConfig();
const ctx = createContext(config);
await migrate(ctx.db, (line) => console.log(`[server] ${line}`));
const app = await buildServer(ctx, { logger: true });
await app.listen({ host: config.HOST, port: config.PORT });
console.log(`[server] SupportX läuft auf ${config.PUBLIC_BASE_URL} (Versandmodus: ${config.SEND_MODE}${config.DEMO_MODE ? ", DEMO-MODUS mit synthetischen Daten" : ""})`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await ctx.db.end();
    process.exit(0);
  });
}
