#!/usr/bin/env node
/**
 * The bridge's pinned version, and the latest upstream release (ADR 0023).
 *
 * Janus is ours to update. It is not an npm dependency and its tag is not a
 * line Dependabot reads, so nothing else would tell us we are behind: run this
 * when the dependencies are updated, and bump `deploy/janus/VERSION` when it
 * says so. The image and the host installer both build from that one pin.
 */
import { readFileSync } from "node:fs";

const versionFile = new URL("../deploy/janus/VERSION", import.meta.url);
const pinned = readFileSync(versionFile, "utf8").trim();

const res = await fetch(
  "https://api.github.com/repos/meetecho/janus-gateway/releases/latest",
  { headers: { accept: "application/vnd.github+json" } },
).catch(() => null);

if (!res?.ok) {
  console.log(`Janus: pinned ${pinned} (could not reach GitHub to compare)`);
  process.exit(0);
}

const latest = (await res.json()).tag_name;
console.log(
  pinned === latest
    ? `Janus: pinned ${pinned}, up to date.`
    : `Janus: pinned ${pinned}, latest upstream ${latest} — update deploy/janus/VERSION.`,
);
