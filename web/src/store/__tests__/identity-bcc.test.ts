import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Email, Identity } from "@/jmap/types";
import { buildEmailObject, useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";

/**
 * The Bcc an identity carries, and what it does to a draft.
 *
 * RFC 8621 leaves `Identity.bcc` to the client, and the rule here is the one a
 * reader can check: the address is written into the Bcc field of the draft when
 * it is opened, so the composer shows the whole truth about who the message
 * reaches. These pin the two halves that a re-implementation gets wrong — it is
 * applied once and not again on the way out (a copy somebody took off stays
 * off), and switching identity swaps it only while the field is still the
 * identity's to own.
 */

const ARCHIVE = { name: null, email: "archive@example.org" };
const OTHER = { name: null, email: "other@example.org" };
const ME = { name: "John", email: "john@example.org" };
const ANN = { name: "Ann", email: "ann@example.com" };

const identityWith = (over: Partial<Identity> = {}): Identity =>
  ({
    id: "i1",
    name: "John",
    email: ME.email,
    replyTo: null,
    bcc: [ARCHIVE],
    textSignature: "",
    htmlSignature: "",
    mayDelete: true,
    ...over,
  }) as Identity;

const body = {
  messageId: ["<x@example.org>"],
  subject: "Numbers",
  references: [],
  inReplyTo: [],
  keywords: {},
  htmlBody: [{ partId: "1", type: "text/html" }],
  textBody: [{ partId: "1", type: "text/html" }],
  bodyValues: {
    "1": { value: "<p>hi</p>", isEncodingProblem: false, isTruncated: false },
  },
  attachments: [],
  receivedAt: "2026-09-04T10:00:00Z",
  mailboxIds: {},
};

const HERS = { ...body, id: "m2", from: [ANN], to: [ME], cc: [] } as unknown as Email;

/** A message that was itself copied to the archive, being sent again. */
const MINE = {
  ...body,
  id: "m1",
  from: [ME],
  to: [ANN],
  cc: [],
  bcc: [OTHER],
} as unknown as Email;

function withIdentities(identities: Identity[]) {
  useMail.setState({
    accountId: "a1",
    identities: identities as never,
    defaultIdentity: (() => identities[0]) as never,
    loadIdentities: (async () => identities) as never,
    getEmails: (async (ids: string[]) => [ids[0] === "m1" ? MINE : HERS]) as never,
    roleId: ((role: string) => (role === "sent" ? "sent1" : null)) as never,
  });
}

const draftFor = (key: string) =>
  useCompose.getState().drafts.find((d) => d.key === key)!;

beforeEach(() => {
  useCompose.setState({ drafts: [], activeKey: null, pendingSends: {} });
  withIdentities([identityWith()]);
});

afterEach(() => {
  useCompose.setState({ drafts: [], activeKey: null, pendingSends: {} });
});

describe("an identity's Bcc reaches the draft", () => {
  it("is in the Bcc field of a new message, and the field is shown", () => {
    const d = draftFor(useCompose.getState().open({}));
    expect(d.bcc).toEqual([ARCHIVE]);
    expect(d.showBcc).toBe(true);
  });

  it("is in the Bcc field of a reply", async () => {
    const key = await useCompose.getState().reply(HERS, "reply");
    const d = draftFor(key);
    expect(d.bcc).toEqual([ARCHIVE]);
    expect(d.showBcc).toBe(true);
    // And the reply is still addressed the way it was before this existed.
    expect(d.to.map((a) => a.email)).toEqual([ANN.email]);
  });

  it("is merged with what the draft was already addressed with, once each", () => {
    const d = draftFor(useCompose.getState().open({ bcc: [OTHER, ARCHIVE] }));
    expect(d.bcc).toEqual([OTHER, ARCHIVE]);
  });

  it("is added to a message sent again, which already had its own Bcc", async () => {
    const key = await useCompose.getState().composeAsNew(MINE);
    const d = draftFor(key);
    expect(d.bcc).toEqual([OTHER, ARCHIVE]);
  });

  /*
   * A draft is what it was written as. The address was in its Bcc when the
   * writer had it on screen; opening it again is not the moment to add a copy
   * nobody can see.
   */
  it("does not add it again to a draft reopened from Drafts", async () => {
    const key = await useCompose
      .getState()
      .openDraftEmail({ id: "m1" } as unknown as Email);
    expect(draftFor(key).bcc).toEqual([OTHER]);
  });
});

describe("a Bcc taken off stays off", () => {
  /*
   * The reason there is no fallback at send time, unlike `replyTo`: the field
   * is the writer's, and a send that put the address back would be a copy that
   * left the building after somebody had taken it off on purpose.
   */
  it("is not put back by the send path", async () => {
    const key = useCompose.getState().open({});
    useCompose.getState().update(key, { bcc: [] });
    const obj = await buildEmailObject(draftFor(key), { forSend: true });
    expect(obj).not.toHaveProperty("bcc");
  });

  it("is not written when the identity carries none", async () => {
    withIdentities([identityWith({ bcc: null })]);
    const key = useCompose.getState().open({});
    expect(draftFor(key).bcc).toEqual([]);
    expect(draftFor(key).showBcc).toBe(false);
    const obj = await buildEmailObject(draftFor(key), { forSend: true });
    expect(obj).not.toHaveProperty("bcc");
  });
});

describe("switching identity carries the Bcc with it", () => {
  const SECOND = identityWith({ id: "i2", email: "alias@example.org", bcc: [OTHER] });

  it("swaps the previous identity's address for the new one's", () => {
    withIdentities([identityWith(), SECOND]);
    const key = useCompose.getState().open({});
    useCompose.getState().setIdentity(key, "i2");
    const d = draftFor(key);
    expect(d.bcc).toEqual([OTHER]);
    expect(d.showBcc).toBe(true);
  });

  /*
   * An address the writer added is theirs. Once the field is no longer exactly
   * what the previous identity put there, it is not the identity's to replace —
   * the same rule `replyTo` follows.
   */
  it("leaves the field alone once the writer has touched it", () => {
    withIdentities([identityWith(), SECOND]);
    const key = useCompose.getState().open({});
    useCompose.getState().update(key, { bcc: [ARCHIVE, ANN] });
    useCompose.getState().setIdentity(key, "i2");
    expect(draftFor(key).bcc).toEqual([ARCHIVE, ANN]);
  });
});
