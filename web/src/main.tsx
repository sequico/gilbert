import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/app.css";
import { BASE_PATH, withBase } from "@/lib/basePath";
import { scheduleServiceWorkerUpdate } from "@/lib/serviceWorkerUpdate";
import { startBuildWatch } from "@/lib/staleBuild";
import { CrashBoundary } from "@/ui/CrashBoundary";
import { App } from "./App";

startBuildWatch();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CrashBoundary>
      <App />
    </CrashBoundary>
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    /*
     * The scope is spelled out rather than left to default to the script's own
     * directory. Both come to `${BASE_PATH}/` today, but the default is a
     * property of where the file happens to sit, and this is a statement about
     * what the worker is allowed to control -- which under a prefix must stop
     * at the mount. A worker scoped to `/` on a host shared with other
     * applications would intercept their navigations too, and its offline
     * fallback would answer them with Gilbert's shell.
     *
     * `updateViaCache: "none"` keeps the worker's script out of the HTTP cache,
     * so asking for it on a timer (`scheduleServiceWorkerUpdate`) reaches the
     * server. That lands a corrected or re-versioned worker; what notices an
     * actual deploy is the version check in `staleBuild.ts`. The timer is
     * stopped when the page is left, since it has no more work to do.
     */
    navigator.serviceWorker
      .register(withBase("/sw.js"), {
        scope: `${BASE_PATH}/`,
        updateViaCache: "none",
      })
      .then((reg) => {
        const stop = scheduleServiceWorkerUpdate(reg);
        window.addEventListener("pagehide", stop, { once: true });
      })
      .catch(() => {
        /* ignore */
      });
  });
}
