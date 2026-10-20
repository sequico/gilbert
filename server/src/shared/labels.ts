/**
 * The label catalog's shape (ADR 0004) and the reserved `G-` labels — one
 * definition, both tiers.
 *
 * A group's labels live in `gilbert/labels.json` in the group account's own
 * Files: `{ labels: [{ keyword, name, color }] }`. The keyword is the stable
 * identity that rides on the messages; the name and colour are display only,
 * so renaming a label changes nothing on any message.
 *
 * The `G-` prefix is reserved for the agent's own processing state, never a
 * human label and never an entry in a group's catalog: the states are the
 * product's own (`AGENT_LABELS`), the agent is what applies them, and it is a
 * **product convention, not a server ACL** — a JMAP keyword is free-form, so
 * what makes these labels reserved is that the client renders them on the
 * individual message, keeps them out of the manual picker, and never
 * aggregates them onto a thread row.
 */

import { isRecord } from "./json.js";

/** The prefix that marks reserved processing state. Reserved, never a human label. */
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
 * included. One definition, both tiers' readers.
 */
export const STARRED_KEYWORD = "$flagged";

/** The keyword that marks a message read. */
export const SEEN_KEYWORD = "$seen";

/** The keyword that marks a message a draft. */
export const DRAFT_KEYWORD = "$draft";

/**
 * The mark a draft the agent wrote carries.
 *
 * A draft a person wrote is theirs: the agent may correct its own (a typo in
 * what it just put in Drafts) without a word, and may not rewrite a person's at
 * all. The keyword is the only thing that tells the two apart once the draft is
 * a message like any other.
 */
export const AGENT_DRAFT_KEYWORD = "gilbert-agent-draft";

/** The keyword that marks a message answered. */
export const ANSWERED_KEYWORD = "$answered";

/** The parsed `labels.json`. */
export interface LabelCatalog {
  labels: LabelCatalogEntry[];
}

/**
 * The reserved labels by the state they name.
 *
 * A call site says `AGENT_LABEL.processed`, never the string: the keyword is
 * the one stable identity that rides on a message, and it is exactly the kind
 * of thing a rename must not be able to miss in one place.
 */
export const AGENT_LABEL = {
  needAttention: "G-needattention",
  processed: "G-processed",
} as const;

/**
 * The reserved labels, with the names a reader sees. One definition, both
 * tiers.
 *
 * The server accepts the keyword the agent marks a message with, and the
 * client renders the name and the colour — from here, never from a group's
 * catalog: the catalog is the group's human labels, and this namespace is the
 * product's own.
 */
export const AGENT_LABELS: ReadonlyArray<LabelCatalogEntry> = [
  {
    keyword: AGENT_LABEL.needAttention,
    name: "Gilbert: needs attention",
    color: "#b91c1c",
  },
  { keyword: AGENT_LABEL.processed, name: "Gilbert: processed", color: "#15803d" },
];

/**
 * Whether a keyword belongs to the reserved `G-` namespace.
 *
 * The comparison is case-insensitive on the prefix: a JMAP keyword is
 * free-form, so case is not what tells a person's own label from a reserved
 * one, and a prefix test that ignored case would let a reserved name be shown
 * as somebody's own.
 */
export function isAgentLabel(keyword: string): boolean {
  return keyword.toLowerCase().startsWith(G_LABEL_PREFIX.toLowerCase());
}

export function isLabelCatalogEntry(x: unknown): x is LabelCatalogEntry {
  if (!isRecord(x)) return false;
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
