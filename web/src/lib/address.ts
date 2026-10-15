import { isEmailAddress } from "@gilbert/shared/address";
import type { EmailAddress } from "@/jmap/types";
import { t } from "@/lib/i18n";
import { stripControls, withoutBidiControls } from "@/lib/text";

/**
 * Whether a string is an address this product will accept.
 *
 * The shared predicate, imported rather than written out: the client and the
 * server both name an address with it, and the copy that lived here was
 * stricter in a way that lost mail. It excluded `' " , ;` from the local part,
 * so `o'brien@example.com` — an address the server accepted, stored and would
 * have delivered — was refused at the composer, the recipient chip marked
 * invalid and the send stopped. A person whose address contains an apostrophe
 * could not write to anybody.
 */
export function isValidEmail(s: string): boolean {
  return isEmailAddress(s);
}

/**
 * Strip RFC 5322 comments — `(...)`, which nest.
 *
 * A comment is prose a person added beside an address and is not part of it; a
 * comma inside one must not split the list either, so this runs before the
 * split. A parenthesis inside a quoted display name is literal, not a comment,
 * which is why the quote state is tracked.
 */
function stripComments(input: string): string {
  let out = "";
  let inQuote = false;
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inQuote) {
      out += ch;
      if (ch === "\\" && i + 1 < input.length) out += input[++i];
      else if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      out += ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

/**
 * Drop a group label — the `Team:` of `Team: a@x, b@y;`.
 *
 * Only a colon before the address part can be one: a display name carrying a
 * colon has to be quoted, and a quoted colon is left alone.
 */
function stripGroupLabel(segment: string): string {
  let inQuote = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (ch === "\\" && inQuote) {
      i++;
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (ch === "<" || ch === "@") return segment;
    if (ch === ":" && !inQuote) return segment.slice(i + 1);
  }
  return segment;
}

/**
 * Parse a free-form recipient string ("Ann <ann@x.com>, bob@y.org; \"C, D\" <c@z>")
 * into a list of EmailAddress. Lenient about the shapes people write, and
 * strict about the one thing that matters: only a real address is accepted.
 */
export function parseAddressList(input: string): EmailAddress[] {
  const out: EmailAddress[] = [];
  const cleaned = stripComments(input);
  let buf = "";
  let inQuote = false;
  let inAngle = false;
  const flush = () => {
    const a = parseOne(buf);
    if (a) out.push(a);
    buf = "";
  };
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]!;
    // A backslash escape inside a quoted name hides the quote it precedes, so
    // the state machine must step over the escaped character.
    if (ch === "\\" && inQuote && i + 1 < cleaned.length) {
      buf += ch + cleaned[++i];
      continue;
    }
    if (ch === '"' && !inAngle) inQuote = !inQuote;
    if (ch === "<" && !inQuote) inAngle = true;
    if (ch === ">" && !inQuote) inAngle = false;
    if ((ch === "," || ch === ";" || ch === "\n") && !inQuote && !inAngle) {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return out;
}

export function parseOne(raw: string): EmailAddress | null {
  const s = stripGroupLabel(stripComments(raw)).trim();
  if (!s) return null;
  const m = /^(.*?)\s*<([^<>]+)>\s*$/.exec(s);
  if (m) {
    const email = m[2]!.trim();
    if (!isValidEmail(email)) return null;
    let name = m[1]!.trim();
    if (name.startsWith('"') && name.endsWith('"'))
      name = name.slice(1, -1).replace(/\\(.)/g, "$1");
    return { name: name || null, email };
  }
  const email = s.replace(/^<|>$/g, "").trim();
  return isValidEmail(email) ? { name: null, email } : null;
}

export function formatAddress(a: EmailAddress | null | undefined): string {
  if (!a) return "";
  const email = stripControls(a.email);
  const clean = a.name ? stripControls(withoutBidiControls(a.name)) : "";
  if (!clean) return email;
  const needsQuote = /[,;<>"()\\]/.test(clean);
  const name = needsQuote ? `"${clean.replace(/(["\\])/g, "\\$1")}"` : clean;
  return `${name} <${email}>`;
}

export function formatAddressList(list: EmailAddress[] | null | undefined): string {
  return (list ?? []).map(formatAddress).join(", ");
}

export function displayName(
  a: EmailAddress | null | undefined,
  fallback = "(unknown)",
): string {
  if (!a) return fallback;
  const name = a.name ? withoutBidiControls(a.name).trim() : "";
  if (name) return name;
  return a.email || fallback;
}

export function shortName(a: EmailAddress | null | undefined): string {
  const n = displayName(a, "");
  if (!n) return "";
  if (n.includes("@")) return n.split("@")[0]!;
  return n.split(/\s+/)[0]!;
}

export function initials(
  a: EmailAddress | { name?: string | null; email?: string } | string | null | undefined,
): string {
  const name = typeof a === "string" ? a : a?.name?.trim() || a?.email || "";
  const parts = name
    .replace(/[<>"]/g, "")
    .split(/[\s._@-]+/)
    .filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

const PALETTE = [
  "#0f766e",
  "#b45309",
  "#7c3aed",
  "#be185d",
  "#1d4ed8",
  "#047857",
  "#c2410c",
  "#4338ca",
  "#a21caf",
  "#0e7490",
  "#b91c1c",
  "#15803d",
];

export function avatarColor(seed: string | null | undefined): string {
  const s = (seed ?? "").toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

/*
 * Declared once, in `@gilbert/shared/address`: the server asks the same
 * question of the accounts a group holds, and two answers to "the same
 * address?" is a match one tier makes and the other does not.
 */
export { sameAddress } from "@gilbert/shared/address";

export function uniqueAddresses(list: EmailAddress[]): EmailAddress[] {
  const seen = new Set<string>();
  const out: EmailAddress[] = [];
  for (const a of list) {
    const k = a.email.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

/**
 * Who a message is from or to, in the words a surface shows it.
 *
 * One answer from one set of pieces, so a row and a header cannot disagree
 * about the people on the same message: each address once, however many times
 * it was written, the reader's own identity as `me`, and past `max` names the
 * rest as a count. How wide one name is — the full display name, the first of
 * it — belongs to the surface, so it is passed in rather than decided here.
 */
export function summarizeAddresses(
  addresses: readonly (EmailAddress | null | undefined)[],
  opts: {
    /** The reader's own identities, lowercased. */
    own?: readonly string[];
    /** How many names to print before the rest become a count. */
    max?: number;
    /** What to say when there is nobody at all. */
    fallback: string;
    /** How one address is named. */
    name?: (a: EmailAddress) => string;
  },
): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const a of addresses) {
    if (!a) continue;
    const k = a.email.trim().toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    names.push(opts.own?.includes(k) ? t("me") : (opts.name ?? displayName)(a));
  }
  if (!names.length) return opts.fallback;
  if (opts.max === undefined || names.length <= opts.max) return names.join(", ");
  return `${names.slice(0, opts.max).join(", ")} +${names.length - opts.max}`;
}

export function domainOf(email: string): string {
  const i = email.lastIndexOf("@");
  return i >= 0 ? email.slice(i + 1).toLowerCase() : "";
}

export interface MailtoFields {
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  body: string;
}

/**
 * Parse a `mailto:` URL (RFC 6068) into composer fields.
 *
 * Recipients may sit in the path, in `to=`, or both; headers other than
 * to/cc/bcc/subject/body are ignored. The path is percent-decoded leniently — a
 * malformed escape yields the raw text rather than throwing. The header values
 * are *not* decoded here: `URLSearchParams` already percent-decodes them, and a
 * second pass would turn a deliberately literal `%2C` in a name into a comma.
 */
export function parseMailto(url: string): MailtoFields {
  const withoutScheme = url.replace(/^mailto:/i, "");
  const q = withoutScheme.indexOf("?");
  const path = q === -1 ? withoutScheme : withoutScheme.slice(0, q);
  const params = new URLSearchParams(q === -1 ? "" : withoutScheme.slice(q + 1));
  const header = (name: string) => {
    for (const [k, v] of params) if (k.toLowerCase() === name) return v;
    return "";
  };
  const addresses = (raw: string) => (raw.trim() ? parseAddressList(raw) : []);
  return {
    to: [...addresses(decode(path)), ...addresses(header("to"))],
    cc: addresses(header("cc")),
    bcc: addresses(header("bcc")),
    subject: header("subject"),
    body: header("body"),
  };
}

function decode(s: string): string {
  try {
    // No `+`-to-space here: that reading is HTML forms, not RFC 6068, and the
    // path it is applied to is an address, where `+` is an ordinary character
    // (`user+tag@example.com`).
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
