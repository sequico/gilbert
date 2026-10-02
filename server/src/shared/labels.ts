/**
 * The label catalog's shape (ADR 0005) and the reserved agent labels — one
 * definition, both tiers.
 *
 * A group's labels live in `gilbert/labels.json` in the group account's own
 * Files: `{ labels: [{ keyword, name, color }] }`. The keyword is the stable
 * identity that rides on the messages; the name and colour are display only,
 * so renaming a label changes nothing on any message.
 *
 * The `G-` prefix is reserved for the agent's own processing state (ADR 0003
 * resolution 9). It is a **product convention, not a server ACL**: a JMAP
 * keyword is free-form, so what makes these labels agent-owned is that the
 * client renders them on the individual message, keeps them out of the manual
 * picker, and never aggregates them onto a thread row. The executor enforces
 * the other half — a rule may not name a `G-` label the group's catalog does
 * not define, because a keyword outside the catalog is not rendered and a
 * state nobody can see is a silent failure.
 */

import { isRecord } from "./json.js";

/** The prefix that marks agent processing state. Reserved, never a human label. */
export const G_LABEL_PREFIX = "G-";

/** The file a group's label catalog lives in, in its own app folder. */
export const GROUP_LABELS_FILE = "labels.json";

/** One entry of a group's label catalog. */
export interface LabelCatalogEntry {
  /** The JMAP keyword; the label's stable identity. */
  keyword: string;
  /** The display name a reader sees. */
  name: string;
  /** A CSS colour the client renders. */
  color: string;
}

/**
 * The keyword a starred message carries.
 *
 * A star is not a document of its own: it is this JMAP keyword on the message,
 * in the account that holds the mail — which is why a group's starred messages
 * are readable by anyone the account's mail is, the installation's agent
 * included. One definition, both tiers' readers and the agent's own lookup
 * (ADR 0020).
 */
export const STARRED_KEYWORD = "$flagged";

/** The keyword that marks a message read. */
export const SEEN_KEYWORD = "$seen";

/** The keyword that marks a message a draft. */
export const DRAFT_KEYWORD = "$draft";

/** The keyword that marks a message answered. */
export const ANSWERED_KEYWORD = "$answered";

/** The parsed `labels.json`. */
export interface LabelCatalog {
  labels: LabelCatalogEntry[];
}

/**
 * The reserved keywords by the state they name.
 *
 * A call site says `AGENT_LABEL.needAttention`, never the string: the keyword
 * is the one stable identity that rides on a message, and it is exactly the
 * kind of thing a rename must not be able to miss in one place.
 */
export const AGENT_LABEL = {
  needAttention: "G-needattention",
  processed: "G-processed",
  awaiting: "G-awaiting",
  rejected: "G-rejected",
} as const;

/**
 * The fixed agent labels an installation creates on a group once the operator
 * has granted the agent there (ADR 0003 resolution 9). The set is deliberately
 * small and total: every state the executor can leave a message in is on this
 * list, so `missingAgentLabels` can name exactly which keyword a rule asked
 * for and the catalog does not have.
 */
export const AGENT_LABELS: ReadonlyArray<LabelCatalogEntry> = [
  {
    keyword: AGENT_LABEL.needAttention,
    name: "Gilbert: needs attention",
    color: "#b91c1c",
  },
  { keyword: AGENT_LABEL.processed, name: "Gilbert: processed", color: "#15803d" },
  {
    keyword: AGENT_LABEL.awaiting,
    name: "Gilbert: awaiting approval",
    color: "#b45309",
  },
  { keyword: AGENT_LABEL.rejected, name: "Gilbert: rejected", color: "#475569" },
];

/**
 * Whether a keyword belongs to the agent's reserved namespace.
 *
 * The comparison is case-insensitive on the prefix: a rule that names
 * `g-processed` is refused upstream by the keyword it has to match, and a
 * prefix test that let it through here would let a reserved name be treated as
 * a person's own label.
 */
export function isAgentLabel(keyword: string): boolean {
  return keyword.toLowerCase().startsWith(G_LABEL_PREFIX.toLowerCase());
}

export function isLabelCatalogEntry(x: unknown): x is LabelCatalogEntry {
  if (!x || typeof x !== "object") return false;
  const l = x as Record<string, unknown>;
  return (
    typeof l.keyword === "string" &&
    l.keyword.length > 0 &&
    typeof l.name === "string" &&
    typeof l.color === "string"
  );
}

export function isLabelCatalog(x: unknown): x is LabelCatalog {
  if (!isRecord(x)) return false;
  const list = x.labels;
  return Array.isArray(list) && list.every(isLabelCatalogEntry);
}

/**
 * The `G-` keywords a rule names that the group's catalog does not define.
 *
 * The executor refuses to run such a rule rather than applying a keyword
 * nobody renders (ADR 0003 resolution 9). Returns them in the order given, so
 * the message can name the first offender.
 */
export function missingAgentLabels(
  catalog: ReadonlyArray<LabelCatalogEntry>,
  keywords: ReadonlyArray<string>,
): string[] {
  const have = new Set(catalog.map((l) => l.keyword));
  const out: string[] = [];
  for (const k of keywords) {
    if (!isAgentLabel(k) || have.has(k) || out.includes(k)) continue;
    out.push(k);
  }
  return out;
}
