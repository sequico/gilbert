import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import type { Email, EmailFilter } from "@/jmap/types";
import { useMail } from "@/store/mail";
import { flushMicrotasks as flush } from "@/test/testkit";

/**
 * A refused write puts the message back.
 *
 * The rollback used to call `getEmails(ids)`, which answers from what is
 * already held -- so for a message on screen it fetched nothing and left the
 * optimistic keyword or folder write exactly where the refused write put it.
 * The list is read again instead, which is what this pins.
 */

const email = (over: Partial<Email> = {}): Email =>
  ({
    id: "e1",
    threadId: "t1",
    mailboxIds: { mb1: true },
    keywords: {},
    ...over,
  }) as unknown as Email;

/**
 * A list holding `e1`, with `truth` as the server's own copy for the re-read.
 *
 * `refreshList` asks through `client.chain`; the answers below are the query's
 * page and the message the server actually holds.
 */
function withList(truth: Email): void {
  useMail.setState({
    accountId: "a1",
    emails: { e1: email() },
    threads: {},
    fullIds: {},
    list: {
      key: "k",
      filter: {} as EmailFilter,
      sort: [],
      collapseThreads: false,
      mailboxId: "mb1",
      label: undefined,
      ids: ["e1"],
      total: 1,
      queryState: "q0",
      loading: false,
      loadingMore: false,
      error: null,
      exhausted: false,
    },
  });
  vi.spyOn(client, "chain").mockResolvedValue(
    new Map([
      ["q", [{ ids: ["e1"], total: 1, queryState: "q1" }]],
      ["e", [{ list: [truth] }]],
    ]) as never,
  );
  // The count refresh the keyword rollback also fires: one request, no answers.
  vi.spyOn(client, "request").mockResolvedValue({ methodResponses: [] } as never);
}

/** The server refusing every keyword/folder write. */
const refuseWrites = () =>
  vi.spyOn(client, "call").mockImplementation((async () => {
    throw new Error("refused");
  }) as never);

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  useMail.setState({ emails: {}, threads: {}, list: null });
});

describe("a refused keyword write", () => {
  it("re-reads the row instead of leaving the optimistic star", async () => {
    withList(email());
    refuseWrites();
    await useMail.getState().star(["e1"], true);
    expect(useMail.getState().emails.e1?.keywords.$flagged).toBeUndefined();
  });
});

describe("a refused label write", () => {
  it("re-reads the row instead of leaving the optimistic folder", async () => {
    withList(email({ mailboxIds: { mb1: true } }));
    refuseWrites();
    await useMail.getState().addToMailbox(["e1"], "mb2", true);
    await flush();
    expect(useMail.getState().emails.e1?.mailboxIds.mb2).toBeUndefined();
    expect(useMail.getState().emails.e1?.mailboxIds.mb1).toBe(true);
  });
});
