#!/usr/bin/env node
/**
 * This repository is an npm workspace: package-lock.json, `npm -w` scripts and
 * `npm run dev:mock`. pnpm or yarn would want their own lockfile and would
 * quietly disagree about the workspace layout, so they are refused here with a
 * message instead of a mystery.
 *
 * The check runs as the `preinstall` script, which every package manager runs
 * before it touches node_modules — so the guard speaks before pnpm can create
 * a pnpm-lock.yaml next to the npm one.
 */
const ua = process.env.npm_config_user_agent ?? "";
if (/^(pnpm|yarn)\//.test(ua)) {
  console.error(
    "[gilbert] this repository uses npm. Run `npm install` — use npm instead of pnpm or yarn.",
  );
  process.exit(1);
}
