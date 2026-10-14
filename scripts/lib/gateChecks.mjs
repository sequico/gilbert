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
 * The names are not written down here at all: they are read out of the same
 * `package.json` commands `check:ci` runs, so the gate and this cannot drift by
 * one of them being edited without the other.
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
  const command = CHECK_COMMANDS.map((name) => scripts[name] ?? "").join(" ");
  return command.match(/(scripts\/[\w.-]+\.mjs)/g) ?? [];
}
