/**
 * Turning whatever states a locale into a BCP-47 tag, once for both tiers.
 *
 * Two places state a locale and neither owns the rule: a deployment's
 * environment, read by the server (an LDAP or system locale like
 * `de_DE.UTF-8@euro`), and the browser's own preferences, read by the client.
 * Both then hand what they read to the same thing — `Intl` — so the guard
 * against a value that is not a language tag at all has to be the same one on
 * both sides, or one tier accepts a string the other refuses.
 *
 * Pure: `Intl` is in both runtimes, and nothing here touches the network, the
 * filesystem or the DOM.
 */

/**
 * The POSIX locale modifiers that name a script, and the only ones worth
 * translating. A variant that carries no script (@valencia, @saaho, @euro …)
 * is dropped.
 */
const SCRIPT_MODIFIERS: Record<string, string> = {
  latin: "Latn",
  latn: "Latn",
  cyrillic: "Cyrl",
  cyrl: "Cyrl",
  devanagari: "Deva",
  iqtelif: "Latn",
};

/**
 * Turn a POSIX-style locale ("de_DE.UTF-8@euro") or BCP-47 tag into a plain
 * BCP-47 tag, or null when it is unusable ("POSIX", "C", garbage).
 */
export function normalizeLocale(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const [head, modifier] = raw.trim().split("@");
  const base = head!.split(".")[0]!.replace(/_/g, "-");
  if (!base || base === "C" || base.toUpperCase() === "POSIX") return null;
  /*
   * A language tag before anything is asked of it: `Intl` throws on some input
   * and answers `"und"` for other input, and neither is a locale to store. The
   * subtag is one to eight characters, not two, because the singleton is a
   * subtag too — `de-DE-u-ca-buddhist` is a German tag whose calendar is stated
   * by an extension, and it is exactly the shape a server reports a locale in.
   * What survives this is still checked by `Intl`, in the `try` below.
   */
  if (!/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(base)) return null;
  const script = modifier ? SCRIPT_MODIFIERS[modifier.toLowerCase()] : undefined;
  try {
    const [canonical] = Intl.getCanonicalLocales(base);
    if (!canonical) return null;
    if (!script) return canonical;
    const loc = new Intl.Locale(canonical);
    // Adding the script only helps when it differs from the one the locale
    // already implies (ru-RU is Cyrillic, so "ru_RU@cyrillic" is just ru-RU).
    const implied = loc.script ?? loc.maximize().script;
    return implied === script
      ? canonical
      : new Intl.Locale(canonical, { script }).toString();
  } catch {
    return null;
  }
}
