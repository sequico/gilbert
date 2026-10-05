import { t } from "@/lib/i18n";

/**
 * The in-force revision's own number, read-only (ADR 0024).
 *
 * An article's title is editable; the revision number is not — it is minted at
 * approval and auto-incremented. The tree and the editor show it the same way,
 * through this one component, so the two cannot drift.
 */
export function KnowledgeRevBadge({ rev }: { rev: number | null }) {
  if (rev === null) return null;
  return <span className="badge muted">{t("rev. {n}", { n: rev })}</span>;
}
