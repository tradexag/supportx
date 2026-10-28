import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-sans/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles.css";

/** Which version is running, bottom left on every page (also before login). */
function VersionStamp() {
  const r = __SUPPORTX_RELEASE__;
  const [y, m, d] = r.date.split("-");
  return <div className="version-stamp" title="Version dieser Installation">SupportX {r.version} · {d}.{m}.{y}</div>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <VersionStamp />
  </StrictMode>,
);
