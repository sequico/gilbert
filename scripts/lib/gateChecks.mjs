import { readFileSync } from "node:fs";

/**
 * The check scripts the pre-push hook asks which paths they read.
 *
 * Named here, once, so the hook and `package.json`'s `check:ci` cannot disagree:
 * `check:ci` runs the checks, this finds them, and a check added to one and not
 * the other shows up as a check the hook has never heard of. The list used to be
 * written inside the hook itself, where `i18n:check` had been missing since it
 * joined the gate — harmless, because the decision fails closed, but the hook
 * could not skip what it was written to skip.
 *
 * The names are read out of `package.json`'s `check:ci` — the `npm run <name>`
 * segments it runs — so the gate and this cannot disagree, and `CHECK_COMMANDS`
 * fixes only the order the found checks are assembled in.
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
