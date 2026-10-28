import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
// Version stamp (release.json at the repository root), baked into the bundle at build time.
const release = JSON.parse(readFileSync(new URL("../../release.json", import.meta.url), "utf8")) as { version: string; date: string };

export default defineConfig({
  root,
  plugins: [react()],
  define: { __SUPPORTX_RELEASE__: JSON.stringify({ version: release.version, date: release.date }) },
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:3000", "/theme.css": "http://127.0.0.1:3000", "/theme/": "http://127.0.0.1:3000" } },
});
