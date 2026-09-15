/**
 * What the JMAP proxy lets through for a session that may not administer:
 * the operator turned it off (`ADMINISTRATION=0`), or the session was signed
 * in without "This is my own device".
 *
 * Hiding the menu is not turning it off (ADR 0001, ADR 0014). `/api/jmap`
 * forwards any method the browser sends, and Stalwart's registry answers
 * whatever the credential's role allows — so without this, an administrator
 * could still manage accounts, or the whole server, from the browser console
 * of an installation whose operator said no. With it off, the proxy refuses
 * every `x:` method except the few that are about the signed-in account
 * itself.
 *
 * An allowlist rather than a list of administrative objects, because the
 * registry has dozens of them — listeners, stores, tracers, system settings —
 * and a new release adds more. An object not named here is refused, which errs
 * toward the operator's decision.
 *
 * The standard JMAP methods (mail, calendars, contacts, files, sharing) are
 * not touched: they act on what the account can already reach.
 */
const SELF_SERVICE = new Set([
  "AccountSettings",
  "AccountPassword",
  "AppPassword",
  "ApiKey",
  "PublicKey",
  "MaskedEmail",
]);

export type GateResult =
  | { ok: true; body: string }
  | { ok: false; method: string | null };

/**
 * Whether a session may administer at all.
 *
 * Two statements, both the installation's, and the second is off by default
 * because it is a restriction rather than a protection this product needs:
 *
 * - `enabled` — the installation offers administration at all. Off means off:
 *   the menu is not drawn and the proxy refuses every `x:` object beyond the
 *   account's own, so an administrator cannot reach the registry from the
 *   browser console of a deployment that said no.
 * - `needsOwnDevice` — an installation that additionally requires the session
 *   to have been signed in on a device marked as the person's own. Off, a
 *   session may administer wherever it was opened, which is what every
 *   installation did before this rule existed; on, a borrowed laptop cannot
 *   reset a password however the operator's directory is set up.
 *
 * The two are separate because they answer different questions and are turned
 * on by different people: the first is a statement about what this installation
 * offers, the second about which machines may use what it offers. Keying the
 * second on the sign-in form's "stay signed in" box is only defensible where an
 * operator has asked for it — a shorter session is not a less trusted one.
 */
export function administrationAllowed(
  enabled: boolean,
  needsOwnDevice: boolean,
  remember: boolean,
): boolean {
  if (!enabled) return false;
  return needsOwnDevice ? remember : true;
}

/**
 * Whether a body could hold a registry method name at all, so the common case
 * — mail, calendars, contacts from a session that may not administer — skips
 * the parse. A method name is a JSON string starting `x:`, which appears in the
 * text as `"x:` unless written with a `\u` escape; a body with neither cannot
 * contain one, and is forwarded exactly as it came.
 */
export function mayNameRegistryMethod(raw: string): boolean {
  return raw.includes('"x:') || raw.includes("\\u");
}

/**
 * Check a JMAP request body. On success, hands back the body to forward —
 * serialized from what was inspected, so the server can never be sent
 * something different from what was checked (a duplicate key, say, read one
 * way here and another way there).
 */
export function gateAdministration(raw: string): GateResult {
  if (!mayNameRegistryMethod(raw)) return { ok: true, body: raw };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, method: null };
  }
  const calls = (parsed as { methodCalls?: unknown } | null)?.methodCalls;
  if (!Array.isArray(calls)) return { ok: false, method: null };
  for (const call of calls) {
    const name = Array.isArray(call) ? call[0] : undefined;
    if (typeof name !== "string") return { ok: false, method: null };
    if (!name.startsWith("x:")) continue;
    const object = name.slice(2).split("/")[0] ?? "";
    if (!SELF_SERVICE.has(object)) return { ok: false, method: name };
  }
  return { ok: true, body: JSON.stringify(parsed) };
}
