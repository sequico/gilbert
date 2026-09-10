/**
 * The label catalog's shape (ADR 0006) and the reserved agent labels — one
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
  { keyword: "G-processed", name: "Gilbert: processed", color: "#15803d" },
  { keyword: "G-awaiting", name: "Gilbert: awaiting approval", color: "#b45309" },
  { keyword: "G-rejected", name: "Gilbert: rejected", color: "#475569" },
];

/** Whether a keyword belongs to the agent's reserved namespace. */
export function isAgentLabel(keyword: string): boolean {
  return keyword.startsWith(G_LABEL_PREFIX);
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
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const list = (x as { labels?: unknown }).labels;
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
