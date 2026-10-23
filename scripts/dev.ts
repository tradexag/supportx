import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { loadDotEnv } from "../packages/storage/env.ts";

/**
 * Local start.
 *   npm run dev   – server + worker + Vite dev server (needs a configured .env)
 *   npm run demo  – DEMO with synthetic data: test doubles for weclapp and Graph,
 *                   demo workspace, built web UI served by the server on one port.
 */
const demo = process.argv.includes("--demo");
loadDotEnv();

if (demo) {
  process.env.DEMO_MODE = "true";
  process.env.ALLOW_TEST_ENDPOINTS = "true";
  process.env.SEND_MODE ??= "drafts_only";
  process.env.DATABASE_URL ??= "postgres://supportx:supportx@127.0.0.1:5432/supportx";
  process.env.MAIL_SYNC_INTERVAL_SEC ??= "15";
  if (!process.env.APP_ENCRYPTION_KEY) {
    // Fixed, public key: acceptable only because the demo stores synthetic test credentials.
    process.env.APP_ENCRYPTION_KEY = Buffer.from("supportx-demo-key-32-bytes-local").toString("base64");
    console.log("[demo] APP_ENCRYPTION_KEY nicht gesetzt – nutze den öffentlichen Demo-Schlüssel (nur für synthetische Daten).");
  }
}

const children: ChildProcess[] = [];
const run = (name: string, args: string[]) => {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "inherit", "inherit"], env: process.env });
  child.on("exit", (code) => {
    console.log(`[${name}] beendet (${code ?? "Signal"})`);
    shutdown(code ?? 1);
  });
  children.push(child);
};
let stopping = false;
const shutdown = (code: number) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const tsx = ["--import", "tsx"];
if (demo) {
  const { startDemoFakes } = await import("./demo-fakes.ts");
  const { seedDemo } = await import("./demo-seed.ts");
  const fakes = await startDemoFakes();
  console.log(`[demo] Testdoubles laufen: weclapp ${fakes.weclapp.baseUrl}, Graph ${fakes.graph.graphBaseUrl}`);
  await seedDemo({ reset: process.argv.includes("--reset") });
  if (!existsSync("apps/web/dist/index.html") || process.argv.includes("--build")) {
    await new Promise<void>((resolve, reject) => {
      const build = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--config", "apps/web/vite.config.ts"], { stdio: "inherit" });
      build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("Web-Build fehlgeschlagen"))));
    });
  }
  run("server", [...tsx, "apps/server/main.ts"]);
  run("worker", [...tsx, "apps/worker/main.ts"]);
  console.log(`[demo] Öffnen: ${process.env.PUBLIC_BASE_URL ?? "http://localhost:3000"}  (DEMO – synthetische Daten, kein Versand)`);
} else {
  run("server", [...tsx, "--watch", "apps/server/main.ts"]);
  run("worker", [...tsx, "--watch", "apps/worker/main.ts"]);
  run("web", ["node_modules/vite/bin/vite.js", "--config", "apps/web/vite.config.ts"]);
}
