/**
 * A group's prose, as a member's client writes it (ADR 0035).
 *
 * Two documents say how a group wants its agent to work: its **standing
 * instruction** — `instruction.json` at the root of the group account's own
 * `gilbert` app folder, the prose that stands for every call — and its
 * **rules**, one document per rule under `rules/`, each naming the surfaces it
 * watches and what should happen. Both live in the **group's account**, so a
 * member writes them with the group's own session, the way its chat is written;
 * nothing is shared out of a personal account.
 *
 * The shapes are one definition, read here rather than restated: the rule's from
 * `@gilbert/agent/rule`, the instruction's and both addresses from
 * `@gilbert/shared/{instruction,rule}`. A document is validated through the
 * server's own parser **before** it is written, so what this tier files is what
 * the agent will read next pass — and a document that is there but unreadable is
 * reported with its name and the reason rather than dropped from the list.
 */

import {
  parseRuleDocumentDetailed,
  RULE_SURFACES,
  RULE_VERSION,
  type RuleDoc,
} from "@gilbert/agent/rule";
import { appDocumentJson } from "@gilbert/shared/appDocument";
import { APP_DOCUMENT_TYPE, FILE_PROPS, FILENODE_SET } from "@gilbert/shared/appFolder";
import {
  INSTRUCTION_FILE,
  INSTRUCTION_VERSION,
  parseInstructionDocumentDetailed,
} from "@gilbert/shared/instruction";
import { RULES_DIR, ruleFileName } from "@gilbert/shared/rule";
import { client, setErrorMessage } from "@/jmap/client";
import type { FileNode, Id, SetResponse } from "@/jmap/types";
import {
  ensureFolder,
  ensureSubfolder,
  findAppFolder,
  findInFolder,
  listChildrenWithState,
  writeAppJson,
  writeBlobInFolder,
} from "@/lib/appFolder";

/** One group's prose, as the panel shows it. */
export interface GroupProse {
  instruction: string;
  rules: RuleDoc[];
  /** Documents that are there but this build cannot read: never silently dropped. */
  unreadable: Array<{ name: string; problem: string }>;
}

/** Read a group's standing instruction and every rule it holds. */
export async function readGroupProse(accountId: Id): Promise<GroupProse> {
  const folder = await findAppFolder(accountId);
  if (!folder) return { instruction: "", rules: [], unreadable: [] };
  const unreadable: GroupProse["unreadable"] = [];

  let instruction = "";
  const doc = await findInFolder(accountId, folder, INSTRUCTION_FILE);
  if (doc?.blobId) {
    const parsed = parseInstructionDocumentDetailed(
      await blobText(accountId, doc.blobId),
    );
    if ("problem" in parsed)
      unreadable.push({ name: INSTRUCTION_FILE, problem: parsed.problem });
    else instruction = parsed.instruction.instruction;
  }

  return {
    instruction,
    rules: await readRules(accountId, folder, unreadable),
    unreadable,
  };
}

/** Save the standing instruction; an emptied field leaves no document behind. */
export async function saveInstruction(accountId: Id, text: string): Promise<void> {
  const instruction = text.trim();
  if (!instruction) {
    const folder = await findAppFolder(accountId);
    const found = folder && (await findInFolder(accountId, folder, INSTRUCTION_FILE));
    if (found) await destroyNode(accountId, found.id);
    return;
  }
  await writeAppJson(accountId, INSTRUCTION_FILE, {
    v: INSTRUCTION_VERSION,
    instruction,
  });
}

/**
 * File one rule under the group's `rules/`, or replace the one filed there.
 *
 * The rule is validated by the server's parser first, so a surface cannot
 * write a document the agent would refuse: what comes back is exactly what was
 * written.
 */
export async function saveRule(accountId: Id, rule: RuleDoc): Promise<RuleDoc> {
  const parsed = parseRuleDocumentDetailed(
    appDocumentJson({
      ...rule,
      v: RULE_VERSION,
      // One order for a rule's list, whatever order a surface named them in:
      // the record's, so a rule that watches the same surfaces is the same
      // document byte for byte.
      watches: RULE_SURFACES.filter((surface) => rule.watches.includes(surface)),
    }),
  );
  if ("problem" in parsed) throw new Error(parsed.problem);
  const folder = await ensureSubfolder(
    accountId,
    await ensureFolder(accountId),
    RULES_DIR,
  );
  const blob = new Blob([appDocumentJson(parsed.rule)], { type: APP_DOCUMENT_TYPE });
  await writeBlobInFolder(
    accountId,
    folder,
    ruleFileName(parsed.rule.id),
    blob,
    APP_DOCUMENT_TYPE,
  );
  return parsed.rule;
}

/** Remove one rule's document; a rule that is not there is already gone. */
export async function deleteRule(accountId: Id, id: string): Promise<void> {
  const app = await findAppFolder(accountId);
  if (!app) return;
  const folder = await findInFolder(accountId, app, RULES_DIR);
  if (folder?.nodeType !== "directory") return;
  const found = await findInFolder(accountId, folder.id, ruleFileName(id));
  if (found) await destroyNode(accountId, found.id);
}

/**
 * A group that has never written a document has no prose, and reading it leaves
 * no folder behind: the app folder is made by the first write, never by a read.
 */
async function readRules(
  accountId: Id,
  app: Id,
  unreadable: GroupProse["unreadable"],
): Promise<RuleDoc[]> {
  const folder = await findInFolder(accountId, app, RULES_DIR);
  if (folder?.nodeType !== "directory") return [];
  const { list } = await listChildrenWithState(accountId, folder.id, FILE_PROPS);
  const rules: RuleDoc[] = [];
  for (const node of list) {
    if (node.nodeType !== "file" || !node.blobId || !node.name.endsWith(".json"))
      continue;
    const parsed = parseRuleDocumentDetailed(await blobText(accountId, node.blobId));
    if ("problem" in parsed) {
      unreadable.push({ name: node.name, problem: parsed.problem });
      continue;
    }
    const id = node.name.slice(0, -".json".length);
    if (parsed.rule.id !== id) {
      unreadable.push({
        name: node.name,
        problem: `"id" is "${parsed.rule.id}" but the document is filed as "${id}".`,
      });
      continue;
    }
    rules.push(parsed.rule);
  }
  return rules.sort((a, b) => a.id.localeCompare(b.id));
}

function blobText(accountId: Id, blobId: Id): Promise<string> {
  return client.fetchBlobText(accountId, blobId, APP_DOCUMENT_TYPE);
}

async function destroyNode(accountId: Id, id: Id): Promise<void> {
  const res = await client.call<SetResponse<FileNode>>(FILENODE_SET, {
    accountId,
    destroy: [id],
  });
  const err = res.notDestroyed?.[id];
  if (err) throw new Error(setErrorMessage(err));
}
