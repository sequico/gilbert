import { readFileSync } from "node:fs";

/**
 * The check scripts the pre-push hook asks which paths they read.
 *
 * The hook follows `package.json`'s `check:ci`: the names are read out of its
 * own `npm run <name>` segments, in the order that script runs them, so the
 * gate and this cannot drift.
 */
export function checkModules(root) {
  const { scripts } = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
  const names = [...(scripts["check:ci"] ?? "").matchAll(/npm run ([\w:.-]+)/g)].map(
    (match) => match[1],
  );
  const command = names.map((name) => scripts[name] ?? "").join(" ");
  return command.match(/(scripts\/[\w.-]+\.mjs)/g) ?? [];
}
