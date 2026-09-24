// The container healthcheck (ADR 0011). Its own file so the probe is not a
// shell-quoted one-liner in the Dockerfile; it reads the running prefix and
// port from the environment, exactly as the process does.
const base = process.env.BASE_PATH ?? "";
const prefix = base.replace(/\/+$/, "");
const port = process.env.PORT ?? "8080";
fetch(`http://127.0.0.1:${port}${prefix}/api/health`)
  .then((res) => process.exit(res.ok ? 0 : 1))
  .catch(() => process.exit(1));
