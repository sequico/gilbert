import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import type { Email, GetResponse, Mailbox, QueryResponse } from "@/jmap/types";
import { useMail } from "@/store/mail";
import type { SieveRule } from "../sieve";
import { applyRuleToMailbox, evaluateRule, evaluateTest } from "../sieveApply";

const email = {
  id: "e1",
  blobId: "b",
  threadId: "t",
  mailboxIds: { inbox: true },
  keywords: {},
  size: 5000,
  receivedAt: "2026-01-01T00:00:00Z",
  from: [{ name: "Ada Lovelace", email: "ada@example.org" }],
  to: [{ name: null, email: "me@x.io" }],
  subject: "Invoice #42 is ready",
  preview: "Please find attached",
  "header:List-Id:asText": "<dev.lists.example.org>",
} as unknown as Email;

describe("sieve client-side evaluation", () => {
  it("evaluates header/address/size/body tests", () => {
    expect(
      evaluateTest(email, {
        type: "header",
        header: "from",
        op: "contains",
        value: "ada@",
      }),
    ).toBe(true);
    expect(
      evaluateTest(email, {
        type: "header",
        header: "subject",
        op: "matches",
        value: "invoice*ready",
      }),
    ).toBe(true);
    expect(
      evaluateTest(email, {
        type: "header",
        header: "subject",
        op: "regex",
        value: "^Invoice #\\d+",
      }),
    ).toBe(true);
    expect(
      evaluateTest(email, { type: "header", header: "list-id", op: "exists", value: "" }),
    ).toBe(true);
    expect(
      evaluateTest(email, {
        type: "header",
        header: "x-none",
        op: "notexists",
        value: "",
      }),
    ).toBe(true);
    expect(
      evaluateTest(email, {
        type: "address",
        header: "from",
        part: "domain",
        op: "is",
        value: "example.org",
      }),
    ).toBe(true);
    expect(
      evaluateTest(email, {
        type: "address",
        header: "from",
        part: "localpart",
        op: "is",
        value: "ada",
      }),
    ).toBe(true);
    expect(evaluateTest(email, { type: "size", op: "over", value: 1000 })).toBe(true);
    expect(evaluateTest(email, { type: "size", op: "under", value: 1000 })).toBe(false);
    expect(
      evaluateTest(
        email,
        { type: "body", op: "contains", value: "attached" },
        "Please find attached the file",
      ),
    ).toBe(true);
  });
  it("combines with allof/anyof", () => {
    const base: SieveRule = {
      id: "r",
      name: "r",
      enabled: true,
      join: "allof",
      tests: [
        { type: "header", header: "from", op: "contains", value: "ada" },
        { type: "header", header: "subject", op: "contains", value: "nope" },
      ],
      actions: [],
    };
    expect(evaluateRule(email, base)).toBe(false);
    expect(evaluateRule(email, { ...base, join: "anyof" })).toBe(true);
    expect(evaluateRule(email, { ...base, tests: [{ type: "true" }] })).toBe(true);
  });
});

/**
 * Business logic review finding: a `fileinto` action with no mailbox id and
 * no full path to resolve against (a rule imported from a hand-written or
 * foreign Sieve script, say) fell back to matching by leaf name across the
 * whole mailbox tree — and picked whichever same-named folder came first in
 * iteration order when two folders shared a name in different parents. That
 * is a silent misfile, not the "folder not found" error a reader could
 * investigate.
 */
describe("applying a fileinto with no id or full path to resolve against", () => {
  const inbox: Mailbox = {
    id: "inbox",
    name: "Inbox",
    role: "inbox",
    parentId: null,
  } as unknown as Mailbox;
  const workReceipts: Mailbox = {
    id: "m1",
    name: "Receipts",
    role: null,
    parentId: "work",
  } as unknown as Mailbox;
  const personalReceipts: Mailbox = {
    id: "m2",
    name: "Receipts",
    role: null,
    parentId: "personal",
  } as unknown as Mailbox;
  const work: Mailbox = {
    id: "work",
    name: "Work",
    role: null,
    parentId: null,
  } as unknown as Mailbox;
  const personal: Mailbox = {
    id: "personal",
    name: "Personal",
    role: null,
    parentId: null,
  } as unknown as Mailbox;

  const matchedEmail = { ...email, id: "e1" } as Email;

  function stubServer() {
    vi.spyOn(client, "call").mockImplementation((async (method: string) => {
      if (method === "Email/query")
        return { ids: ["e1"], total: 1 } as unknown as QueryResponse;
      if (method === "Email/get")
        return { list: [matchedEmail] } as unknown as GetResponse<Email>;
      if (method === "Mailbox/get") return { list: [] };
      throw new Error(`unexpected call: ${method}`);
    }) as never);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is refused as ambiguous rather than misfiled into an arbitrary match", async () => {
    stubServer();
    useMail.setState({
      accountId: "a1",
      mailboxes: { inbox, work, personal, m1: workReceipts, m2: personalReceipts },
      move: vi.fn(async () => {
        throw new Error("must not be called: the target is ambiguous");
      }),
      addToMailbox: vi.fn(async () => {
        throw new Error("must not be called: the target is ambiguous");
      }),
    } as never);

    const rule: SieveRule = {
      id: "r",
      name: "r",
      enabled: true,
      join: "allof",
      tests: [{ type: "true" }],
      // A raw imported rule: only the leaf name, no id, no full path.
      actions: [{ type: "fileinto", mailbox: "Receipts" }],
    };
    const result = await applyRuleToMailbox(rule, "inbox");
    expect(result.matched).toBe(1);
    expect(result.skippedActions).toHaveLength(1);
    expect(result.skippedActions[0]).toMatch(/Receipts/);
    expect(result.skippedActions[0]).toMatch(/2 folders share/);
  });

  it("still resolves by leaf name when only one folder has it", async () => {
    stubServer();
    const move = vi.fn(async () => {});
    useMail.setState({
      accountId: "a1",
      mailboxes: { inbox, work, m1: workReceipts },
      move,
      addToMailbox: vi.fn(async () => {}),
    } as never);

    const rule: SieveRule = {
      id: "r",
      name: "r",
      enabled: true,
      join: "allof",
      tests: [{ type: "true" }],
      actions: [{ type: "fileinto", mailbox: "Receipts" }],
    };
    const result = await applyRuleToMailbox(rule, "inbox");
    expect(result.skippedActions).toHaveLength(0);
    expect(move).toHaveBeenCalledWith(["e1"], "m1", { silent: true });
  });
});
