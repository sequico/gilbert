import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The two doors of a group route, kept apart by a test rather than by memory.
 *
 * `/groups/:name/…` is a **member's** surface: it may act only as the caller's
 * own session (`memberGroupAccess`), and it must never reach the installation's
 * credential — that would let a signed-in user read another group's documents
 * by typing its name. `/admin/groups/:name/…` is an administrator's: it is
 * guarded by `requireAdmin` and reaches the group through the installation door
 * (`resolveGroupAccess`).
 *
 * Both shapes are one route registration away from becoming the other, and the
 * mistake is invisible in review and passes every behavioural test a fixture
 * happens to run as an administrator. So the rule is read off the registrations
 * themselves, the way `i18n-literals` reads the code it checks.
 */

const ROUTES = join(import.meta.dirname, "routes");

/** Every `api.<method>("<path>", …)` registration with the text that follows it. */
function registrations(source: string): Array<{ path: string; body: string }> {
  const starts = [...source.matchAll(/^\s*api\.(?:get|post|put|delete)\(/gm)];
  return starts.map((match, at) => {
    const from = match.index ?? 0;
    /*
     * A registration ends where its handler ends, not where the next one begins: a
     * helper written between two routes is nobody's handler, and reading it as one
     * made the member route above it look as though it reached the installation.
     */
    const to = endOfRegistration(source, from) ?? starts[at + 1]?.index ?? source.length;
    const block = source.slice(from, to);
    const path = /\(\s*"([^"]+)"/.exec(block)?.[1] ?? "";
    return { path, body: block };
  });
}

/** Where the registration that starts at `from` closes, by counting its braces. */
function endOfRegistration(source: string, from: number): number | null {
  const open = source.indexOf("{", from);
  if (open < 0) return null;
  let depth = 0;
  for (let at = open; at < source.length; at += 1) {
    const character = source[at];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  return null;
}

/** The route files that register a group or admin-group route. */
function groupRouteFiles(): Array<{ file: string; source: string }> {
  return readdirSync(ROUTES)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((file) => ({ file, source: readFileSync(join(ROUTES, file), "utf8") }))
    .filter(({ source }) => /\/admin\/groups\/|\/groups\//.test(source));
}

test("a member's group route never reaches the installation credential", () => {
  const offenders: string[] = [];
  for (const { file, source } of groupRouteFiles()) {
    for (const { path, body } of registrations(source)) {
      if (!path.startsWith("/groups/")) continue;
      if (body.includes("resolveGroupAccess"))
        offenders.push(`${file}: ${path} reaches the installation door`);
      if (!body.includes("memberGroupAccess"))
        offenders.push(`${file}: ${path} does not check membership`);
    }
  }
  assert.deepEqual(offenders, [], "a member route acts only as the caller's own session");
});

test("an administrator's group route says so, and reaches the group as the installation", () => {
  const offenders: string[] = [];
  for (const { file, source } of groupRouteFiles()) {
    for (const { path, body } of registrations(source)) {
      if (!path.startsWith("/admin/")) continue;
      if (!body.includes("requireAdmin"))
        offenders.push(`${file}: ${path} is not admin-guarded`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "an admin route names its guard in its own registration",
  );
});
