import { existsSync } from "node:fs";

/** Load a local .env file if present (Node's built-in loader; real env vars win). */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  const before = { ...process.env };
  process.loadEnvFile(path);
  for (const [key, value] of Object.entries(before)) process.env[key] = value;
}
