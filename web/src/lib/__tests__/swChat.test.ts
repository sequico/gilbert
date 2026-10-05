import { describe, expect, it } from "vitest";
import { workerSource } from "./readSource";

/*
 * The rules the worker's chat handler applies, held against the reason for
 * them.
 *
 * `web/public/sw.js` is not a module a test can import: it registers listeners
 * on `self` at load. So this file reads it, the same loader `swPushRules.test.ts`
 * uses, and each assertion fails when the rule it names is removed. What a live
 * 0.16 does with the read is ADR 0016's `chat-wake-read` debt; the rules the
 * worker applies to what it reads are pinned here.
 */
const worker = workerSource();

describe("the worker's chat rules", () => {
  it("reads a chat only for an account the briefing names", () => {
    expect(worker).toContain('("FileNode" in types)');
    expect(worker).toContain("accounts.find((a) => a.accountId === accountId)");
  });

  it("never announces the reader's own message", () => {
    expect(worker).toContain("facts.ownAddress && from === facts.ownAddress");
  });

  it("never announces a message at or before the watermark", () => {
    expect(worker).toContain("account.watermark && at <= account.watermark");
  });

  it("tags each chat notification by node, so a re-push collapses", () => {
    expect(worker).toMatch(/tag: `gilbert-chat-\$\{node\.id\}`/);
  });

  it("reads the newest page of a chat folder from its end", () => {
    expect(worker).toContain("total - CHAT_READ");
    expect(worker).toContain("urn:ietf:params:jmap:filenode");
  });

  it("never lets a FileNode-only change fall through to a mail notice", () => {
    // The reader's own settings write, an upload and an agent document all
    // wear FileNode; the generic notice is for a delivery that carried no
    // message. The guard is the type filter: only an account the briefing lists
    // without an Inbox is announced, and only a change that is not FileNode
    // alone.
    expect(worker).toContain("await chatNotifications(data, facts);");
    expect(worker).toContain('Object.keys(types).some((k) => k !== "FileNode")');
    expect(worker).toContain("if (!account || account.inboxId) return false;");
  });
});
