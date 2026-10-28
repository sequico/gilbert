/**
 * The search grammar: one definition, read by the mail client and by an agent.
 *
 * A person types `from:ada is:unread has:attachment invoice` into the client's
 * search box, and an agent asks for the same thing in a lookup. Both mean the
 * same thing because both come through here: `parseQuery` turns the text into a
 * shape, `buildFilter` turns that shape into a JMAP filter, and neither tier
 * owns a copy of the other's idea of what `is:starred` means.
 *
 * This is a **control** surface and not a permission one: the filter it builds
 * is handed to `Email/query` inside the session that asked, so a query can only
 * narrow what that session could already read.
 */

import { SEEN_KEYWORD, STARRED_KEYWORD } from "./labels.js";

interface ParsedQuery {
  text: string[];
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  hasAttachment?: boolean;
  unread?: boolean;
  read?: boolean;
  starred?: boolean;
  in?: string;
  label?: string[];
  before?: string;
  after?: string;
  larger?: number;
  smaller?: number;
  notLabel?: string[];
}

/**
 * A mailbox as the grammar needs it: an id, a name, and the role it answers to.
 *
 * Declared here rather than imported from either tier, because the grammar is
 * shared and must not depend on one tier's account model.
 */
export interface SearchMailbox {
  id: string;
  name: string;
  role?: string | null;
}

interface SearchFilterCondition {
  inMailbox?: string;
  before?: string;
  after?: string;
  minSize?: number;
  maxSize?: number;
  hasKeyword?: string;
  notKeyword?: string;
  hasAttachment?: boolean;
  text?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
}

interface SearchFilterOperator {
  operator: "AND" | "OR" | "NOT";
  conditions: SearchFilterCondition[];
}

export type SearchFilter = SearchFilterCondition | SearchFilterOperator;

/**
 * The grammar in one line, for the places that have to describe it.
 *
 * A prompt that offered a syntax this module does not parse would be a promise
 * the server refuses, so the sentence a model is given is written here, beside
 * the parser that keeps it true (ADR 0038).
 */
export const SEARCH_GRAMMAR =
  'the mail search grammar: bare words match text, and "from:", "to:", "cc:", ' +
  '"subject:", "body:", "in:"/"folder:" (a folder name or role), ' +
  '"label:"/"keyword:" and "-label:"/"-keyword:", "is:unread", "is:read", ' +
  '"is:starred"/"is:flagged", "has:star"/"has:flag"/"has:attachment", ' +
  '"before:"/"older:"/"older_than:", "after:"/"since:"/"newer:"/"newer_than:", ' +
  '"larger:"/"size:", "smaller:"';

const SIZE_RE = /^(\d+(?:\.\d+)?)\s*([kmg]?b?)$/i;
function parseSize(s: string): number | undefined {
  const m = SIZE_RE.exec(s.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  const mult = unit.startsWith("k")
    ? 1024
    : unit.startsWith("m")
      ? 1024 ** 2
      : unit.startsWith("g")
        ? 1024 ** 3
        : 1;
  return Math.round(n * mult);
}

/**
 * A date built from named components, or null when the components do not form
 * one.
 *
 * JS rolls an out-of-range component into the next month or year, so
 * `2026-02-30` silently becomes March 2 and a search for the 30th finds a
 * different day. The month and the day are checked against the month's true
 * length first, so a date that names a day the month does not have is refused
 * rather than searched as another.
 */
function makeLocalDate(y: number, m: number, dd: number): Date | null {
  if (m < 1 || m > 12 || dd < 1) return null;
  const daysInMonth = new Date(y, m, 0).getDate();
  if (dd > daysInMonth) return null;
  return new Date(y, m - 1, dd);
}

function parseDate(s: string, endOfDay = false): string | undefined {
  const t = s.trim();
  let d: Date | null = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t) || /^\d{4}\/\d{2}\/\d{2}$/.test(t)) {
    const [y, m, dd] = t.split(/[-/]/).map(Number) as [number, number, number];
    d = makeLocalDate(y, m, dd);
  } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t)) {
    const [m, dd, y] = t.split("/").map(Number) as [number, number, number];
    d = makeLocalDate(y, m, dd);
  } else {
    const rel = /^(\d+)([dwmy])$/.exec(t);
    if (rel) {
      d = new Date();
      const n = Number(rel[1]);
      if (rel[2] === "d") d.setDate(d.getDate() - n);
      if (rel[2] === "w") d.setDate(d.getDate() - n * 7);
      if (rel[2] === "m") d.setMonth(d.getMonth() - n);
      if (rel[2] === "y") d.setFullYear(d.getFullYear() - n);
    } else {
      const p = new Date(t);
      if (!Number.isNaN(p.getTime())) d = p;
    }
  }
  if (!d || Number.isNaN(d.getTime())) return undefined;
  if (endOfDay) d.setHours(23, 59, 59, 999);
  else d.setHours(0, 0, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Tokenize respecting quotes. */
function tokenize(q: string): string[] {
  const out: string[] = [];
  const re = /(\S+?:"[^"]*"|"[^"]*"|\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) out.push(m[1]!);
  return out;
}

export function parseQuery(q: string): ParsedQuery {
  const p: ParsedQuery = { text: [] };
  for (const tok of tokenize(q)) {
    const idx = tok.indexOf(":");
    const key = idx > 0 ? tok.slice(0, idx).toLowerCase() : "";
    let val = idx > 0 ? tok.slice(idx + 1) : tok;
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    const neg = key.startsWith("-");
    const k = neg ? key.slice(1) : key;
    /*
     * Only `-label:`/`-keyword:` are negatable; the grammar promises no other
     * `-key:`. Any other negated operator is therefore not one, and is searched
     * as the bare text it is rather than applied as the **positive** filter the
     * `-` was written to invert — `-from:ada` must not mean `from:ada`.
     */
    if (neg && k !== "label" && k !== "keyword") {
      p.text.push(tok);
      continue;
    }
    switch (k) {
      case "from":
        p.from = val;
        break;
      case "to":
        p.to = val;
        break;
      case "cc":
        p.cc = val;
        break;
      case "subject":
        p.subject = val;
        break;
      case "body":
        p.body = val;
        break;
      case "has":
        if (val === "attachment") p.hasAttachment = true;
        if (val === "star" || val === "flag") p.starred = true;
        break;
      case "is":
        if (val === "unread") p.unread = true;
        if (val === "read") p.read = true;
        if (val === "starred" || val === "flagged") p.starred = true;
        break;
      case "in":
      case "folder":
        p.in = val;
        break;
      case "label":
      case "keyword":
        if (neg) (p.notLabel ??= []).push(val);
        else (p.label ??= []).push(val);
        break;
      case "before":
        p.before = parseDate(val);
        break;
      case "after":
      case "since":
        p.after = parseDate(val);
        break;
      case "newer":
      case "newer_than":
        p.after = parseDate(val);
        break;
      case "older":
      case "older_than":
        p.before = parseDate(val);
        break;
      case "larger":
      case "size":
        p.larger = parseSize(val);
        break;
      case "smaller":
        p.smaller = parseSize(val);
        break;
      default:
        p.text.push(val);
    }
  }
  return p;
}

/**
 * A filter condition no message satisfies.
 *
 * Used when `in:` names a folder that is not there: the search must return
 * nothing, where dropping the filter widened it to every mailbox. `before`
 * strictly earlier than `after` cannot both hold, whichever bounds a server
 * treats as inclusive.
 */
const NO_MATCH: SearchFilterCondition = {
  before: "1970-01-01T00:00:00Z",
  after: "1970-01-01T00:00:01Z",
};

export function buildFilter(
  p: ParsedQuery,
  mailboxes: Record<string, SearchMailbox>,
  currentMailbox?: string | null,
): SearchFilter {
  const conds: SearchFilterCondition[] = [];
  const c: SearchFilterCondition = {};
  if (p.text.length) c.text = p.text.join(" ");
  if (p.from) c.from = p.from;
  if (p.to) c.to = p.to;
  if (p.cc) c.cc = p.cc;
  if (p.subject) c.subject = p.subject;
  if (p.body) c.body = p.body;
  if (p.hasAttachment) c.hasAttachment = true;
  if (p.unread) c.notKeyword = SEEN_KEYWORD;
  if (p.read) c.hasKeyword = SEEN_KEYWORD;
  if (p.before) c.before = p.before;
  if (p.after) c.after = p.after;
  if (p.larger != null) c.minSize = p.larger;
  if (p.smaller != null) c.maxSize = p.smaller;
  if (p.in) {
    const mb = resolveMailbox(p.in, mailboxes);
    if (mb) c.inMailbox = mb.id;
    // A name that resolves to nothing is not "every folder": it is a search in
    // a folder that is not there, which must return nothing. Dropping the
    // filter silently widened the query to every mailbox.
    else if (!isEverywhere(p.in.toLowerCase())) conds.push(NO_MATCH);
  } else if (currentMailbox) {
    c.inMailbox = currentMailbox;
  }
  conds.push(c);
  if (p.starred) conds.push({ hasKeyword: STARRED_KEYWORD });
  for (const l of p.label ?? []) conds.push({ hasKeyword: l });
  for (const l of p.notLabel ?? []) conds.push({ notKeyword: l });
  if (conds.length === 1) return conds[0]!;
  return { operator: "AND", conditions: conds };
}

/**
 * Whether a lower-cased `in:` name means "every folder" rather than one.
 *
 * `in:anywhere` and `in:all` widen a search back to every mailbox. `resolveMailbox`
 * answers `undefined` both for them and for a name that matched nothing, so the
 * two are told apart here: one widens, the other must not drop the filter.
 */
function isEverywhere(lowered: string): boolean {
  return lowered === "anywhere" || lowered === "all";
}

export function resolveMailbox(
  name: string,
  mailboxes: Record<string, SearchMailbox>,
): SearchMailbox | undefined {
  const n = name.toLowerCase();
  const list = Object.values(mailboxes);
  const byRole = list.find(
    (m) =>
      m.role === n ||
      (n === "spam" && m.role === "junk") ||
      (n === "starred" && m.role === "flagged") ||
      (n === "anywhere" && m.role === "all"),
  );
  if (byRole) return byRole;
  if (isEverywhere(n)) return undefined;
  return (
    list.find((m) => m.name.toLowerCase() === n) ??
    list.find((m) => m.name.toLowerCase().includes(n))
  );
}

export function describeFilter(p: ParsedQuery): string {
  const parts: string[] = [];
  if (p.text.length) parts.push(`"${p.text.join(" ")}"`);
  if (p.from) parts.push(`from ${p.from}`);
  if (p.to) parts.push(`to ${p.to}`);
  if (p.subject) parts.push(`subject ${p.subject}`);
  if (p.hasAttachment) parts.push("has attachment");
  if (p.unread) parts.push("unread");
  if (p.starred) parts.push("starred");
  if (p.in) parts.push(`in ${p.in}`);
  return parts.join(", ") || "all mail";
}
