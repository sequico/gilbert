// The container healthcheck (ADR 0011). Its own file so the probe is not a
// shell-quoted one-liner in the Dockerfile. It reads the running prefix the
// same way the rest of the app does -- `normalizeBasePath`, the one definition
// of what `/mail/` means -- and the port from the environment.
import { normalizeBasePath } from "./basePath.mjs";

const base = normalizeBasePath(process.env.BASE_PATH ?? "");
const port = process.env.PORT ?? "8080";
fetch(`http://127.0.0.1:${port}${base}/api/health`)
  .then((res) => process.exit(res.ok ? 0 : 1))
  .catch(() => process.exit(1));
