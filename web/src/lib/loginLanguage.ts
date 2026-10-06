import { useSettings } from "@/store/settings";

/**
 * The interface language picked on the sign-in form.
 *
 * Picked before the account is known, so it cannot be a setting yet: the
 * settings store refuses writes until the installation's policy has been read
 * (ADR 0001), and that policy is the signed-in account's own. This carries the
 * choice across the sign-in boundary in memory; `applyLoginLanguage` writes it
 * through the settings door once the account's file is in hand. A reload before
 * signing in forgets it, which is the whole scope the choice has.
 */
let chosen: string | null = null;

/** Remember the language picked on the sign-in form. */
export function rememberLoginLanguage(tag: string): void {
  chosen = tag;
}

/**
 * Write the sign-in choice into the account's settings, if there is one and it
 * would change anything.
 *
 * Through `update`, the one door: an installation that *enforces* the interface
 * language still wins, and the choice reaches the account's `settings.json`
 * like any other setting. Called once the account's own settings have loaded,
 * so it lands after the file rather than being overwritten by it.
 */
export function applyLoginLanguage(): void {
  if (chosen === null) return;
  const tag = chosen;
  chosen = null;
  if (tag === useSettings.getState().settings.uiLanguage) return;
  useSettings.getState().update({ uiLanguage: tag });
}

/** Only for tests: forget any pending choice. */
export function resetLoginLanguageForTest(): void {
  chosen = null;
}
