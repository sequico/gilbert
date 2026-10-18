/**
 * A group's prose, written through the administration's door (ADR 0035).
 *
 * A group's standing instruction and its rules are decided by an installation
 * administrator (owner decision 2026-10-18), so this tier does not write the
 * group's account itself: it calls the routes under `/api/admin/groups/<name>`
 * and the server writes as the Master, behind the same door as the rest of the
 * administration. That is what makes the decision a boundary rather than a
 * hidden button.
 *
 * The shapes are the server's own (`@gilbert/agent/rule`,
 * `@gilbert/shared/instruction`), the documents are validated by the server's
 * parser, and the write is a compare-and-set: the state a read answered is sent
 * back, and a write whose account moved under it is refused with 409.
 */

import type { RuleDoc } from "@gilbert/agent/rule";
import { apiFetch } from "@/jmap/client";

/** One group's prose, as the route answers it. */
export interface GroupProse {
  instruction: string;
  rules: RuleDoc[];
  /** The account's FileNode state the read saw: what a write is conditioned on. */
  state: string;
}

function prosePath(group: string, rest = ""): string {
  return `/api/admin/groups/${encodeURIComponent(group)}/prose${rest}`;
}

/** Read a group's standing instruction and its rules. */
export async function readGroupProse(group: string): Promise<GroupProse> {
  return await apiFetch<GroupProse>(prosePath(group));
}

/** Save the standing instruction; an emptied field leaves no document behind. */
export async function saveInstruction(
  group: string,
  text: string,
  state?: string,
): Promise<void> {
  await apiFetch(prosePath(group, "/instruction"), {
    method: "PUT",
    body: JSON.stringify({ instruction: text, ...(state ? { ifInState: state } : {}) }),
  });
}

/** File one rule, or replace the one filed there, and answer what was written. */
export async function saveRule(
  group: string,
  rule: RuleDoc,
  state?: string,
): Promise<RuleDoc> {
  const res = await apiFetch<{ rule: RuleDoc }>(
    prosePath(group, `/rules/${encodeURIComponent(rule.id)}`),
    {
      method: "PUT",
      body: JSON.stringify({ rule, ...(state ? { ifInState: state } : {}) }),
    },
  );
  return res.rule;
}

/** Remove one rule's document. */
export async function deleteRule(
  group: string,
  id: string,
  state?: string,
): Promise<void> {
  await apiFetch(prosePath(group, `/rules/${encodeURIComponent(id)}`), {
    method: "DELETE",
    body: JSON.stringify({ ...(state ? { ifInState: state } : {}) }),
  });
}
