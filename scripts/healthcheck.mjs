// The container healthcheck (ADR 0011). Its own file so the probe is not a
// shell-quoted one-liner in a Dockerfile: the image's `HEALTHCHECK` runs it
// against the app's own health route. It reads the running prefix the same way
// the rest of the app does -- `normalizeBasePath`, the one definition of what
// `/mail/` means -- and the port from the environment.
import { normalizeBasePath } from "./basePath.mjs";

const base = normalizeBasePath(process.env.BASE_PATH ?? "");
const port = process.env.PORT ?? "8080";
const url = `http://127.0.0.1:${port}${base}/api/health`;
fetch(url)
  .then((res) => process.exit(res.ok ? 0 : 1))
  .catch(() => process.exit(1));
