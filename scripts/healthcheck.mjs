// The container healthcheck (ADR 0011). Its own file so the probe is not a
// shell-quoted one-liner in a Dockerfile or a compose file: both use it, the
// app's own health route and the agent's. It reads the running prefix the same
// way the rest of the app does -- `normalizeBasePath`, the one definition of
// what `/mail/` means -- and the port from the environment; `HEALTH_URL` names
// a whole endpoint outright, which is what a service whose health route is not
// the app's own (`agent`, `GILBERT_AGENT_HEALTH_PORT`) passes.
import { normalizeBasePath } from "./basePath.mjs";

const base = normalizeBasePath(process.env.BASE_PATH ?? "");
const port = process.env.PORT ?? "8080";
const url = process.env.HEALTH_URL || `http://127.0.0.1:${port}${base}/api/health`;
fetch(url)
  .then((res) => process.exit(res.ok ? 0 : 1))
  .catch(() => process.exit(1));
