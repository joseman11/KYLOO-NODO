import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { isNativeApp } from "./api";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// El service worker solo funciona en contexto seguro (HTTPS o localhost)
// En la app envoltorio la interfaz ya va dentro de la app (siempre disponible sin red): no hace falta ni conviene el service worker
if (
  "serviceWorker" in navigator &&
  window.isSecureContext &&
  import.meta.env.PROD &&
  !isNativeApp()
) {
  navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}
