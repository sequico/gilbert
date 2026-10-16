import { AGENT_LABELS } from "@gilbert/shared/labels";
import type { Label } from "@/store/settings";

/**
 * The reserved labels a message carries (ADR 0005).
 *
 * The reserved `G-` namespace is the product's own, never a group's: a
 * message's processing state is named in code (`AGENT_LABELS`) and never
 * stored in a group's catalog, so what a message carries is matched against
 * that vocabulary and nothing else. The client renders these on the individual
 * message and nowhere else — never in the manual picker, never on a thread row.
 */
export function agentLabelsOn(keywords: Record<string, boolean> | undefined): Label[] {
  return AGENT_LABELS.filter((label) => keywords?.[label.keyword]);
}
