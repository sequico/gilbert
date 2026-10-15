import { readFileSync } from "node:fs";

/**
 * The check scripts the pre-push hook asks which paths they read.
 *
 * The hook follows `package.json`'s `check:ci`: the names are read out of its
 * own `npm run <name>` segments, so the gate and this cannot drift, and
 * `CHECK_COMMANDS` fixes only the order the found checks are assembled in.
 */
export const CHECK_COMMANDS = [
  "adr:owed",
  "adr:cite",
  "config:dead",
  "workflow:pin",
  "i18n:check",
];

/** The script files those commands run, in the order the gate runs them. */
export function checkModules(root) {
  const { scripts } = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
  const names = [...(scripts["check:ci"] ?? "").matchAll(/npm run ([\w:.-]+)/g)].map(
    (match) => match[1],
  );
  const rank = (name) => {
    const at = CHECK_COMMANDS.indexOf(name);
    return at === -1 ? CHECK_COMMANDS.length : at;
  };
  const command = names
    .sort((a, b) => rank(a) - rank(b))
    .map((name) => scripts[name] ?? "")
    .join(" ");
  return command.match(/(scripts\/[\w.-]+\.mjs)/g) ?? [];
}
