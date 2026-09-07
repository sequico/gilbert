import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Email } from "@/jmap/types";
import { useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";

/**
 * "Compose as new" is a mail sent again, not a mail passed on. What it keeps is
 * easy to see on screen; what it must leave behind is not, and that is what
 * these are for -- a draft that kept `draftId` would destroy the message it was
 * made from on send, and one that kept `relatedEmailId` would mark it answered
 * or forwarded by a mail that is neither.
 */

const SENT: Email = {
  id: "m1",
  messageId: ["<old-one@example.org>"],
  from: [{ name: "John", email: "john@example.org" }],
  to: [{ name: "Ann", email: "ann@example.com" }],
  cc: [{ name: null, email: "cc@example.com" }],
  bcc: [{ name: null, email: "bcc@example.com" }],
  replyTo: [{ name: null, email: "desk@example.org" }],
  subject: "Quarterly numbers",
  references: ["<older@example.org>"],
  inReplyTo: ["<older@example.org>"],
  keywords: {},
  htmlBody: [{ partId: "1", type: "text/html" }],
  textBody: [{ partId: "1", type: "text/html" }],
  bodyValues: {
    "1": { value: "<p>Here they are.</p>", isEncodingProblem: false, isTruncated: false },
  },
  attachments: [
    {
      blobId: "b1",
      name: "numbers.pdf",
      type: "application/pdf",
      size: 1024,
      cid: null,
      disposition: "attachment",
    },
    {
      blobId: "b2",
      name: "logo.png",
      type: "image/png",
      size: 64,
      cid: "logo@x",
      disposition: "inline",
    },
  ],
} as unknown as Email;

/** The same mail, but from somebody else. */
const RECEIVED: Email = {
  ...SENT,
  id: "m2",
  from: [{ name: "Ann", email: "ann@example.com" }],
} as Email;

const IDENTITIES = [
  { id: "i1", name: "John", email: "john@example.org", replyTo: null },
  { id: "i2", name: "John (other)", email: "other@example.org", replyTo: null },
];

function mailState(email: Email) {
  useMail.setState({
    accountId: "a1",
    identities: IDENTITIES as never,
    getEmails: (async () => [email]) as never,
    defaultIdentity: (() => IDENTITIES[1]) as never,
  });
}

const draftFor = async (email: Email) => {
  mailState(email);
  const key = await useCompose.getState().composeAsNew(email);
  return useCompose.getState().drafts.find((d) => d.key === key)!;
};

beforeEach(() => useCompose.setState({ drafts: [], activeKey: null }));
afterEach(() => useCompose.setState({ drafts: [], activeKey: null }));

/** A mail whose body carries a remote (tracking) image. */
const TRACKER = "http://tracker.example/x.gif";
function withRemoteImage(base: Email): Email {
  return {
    ...base,
    id: `${base.id}-img`,
    bodyValues: {
      "1": {
        value: `<p>Here they are.</p><img src="${TRACKER}">`,
        isEncodingProblem: false,
        isTruncated: false,
      },
    },
  } as Email;
}

/*
 * Quoting a message used to fetch its remote images the moment the draft
 * opened: all three "make a draft from an existing message" flows sanitised
 * with `allowRemote: true`, no consent asked and no proxy in between, so a
 * reply to a tracking-pixel mail loaded the pixels. The quote now asks the
 * same question the reader does (settings + sender), and a blocked image is
 * left as the reader's placeholder so nothing is fetched.
 */
describe("quoting a message with remote images", () => {
  it("blocks them by default (ask policy), leaving the placeholder form", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, imagePolicy: "ask" } });
    const d = await draftFor(withRemoteImage(RECEIVED));
    expect(d.html).toContain("data-ihm-blocked");
    expect(d.html).not.toContain(`src="${TRACKER}"`);
  });

  it("keeps them when the policy is to show them always", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, imagePolicy: "always" } });
    const d = await draftFor(withRemoteImage(RECEIVED));
    expect(d.html).not.toContain("data-ihm-blocked");
    expect(d.html).toContain(`src="${TRACKER}"`);
  });

  it("keeps them for a sender the reader has trusted", async () => {
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        trustedImageSenders: ["ann@example.com"],
      },
    });
    const d = await draftFor(withRemoteImage(RECEIVED));
    expect(d.html).not.toContain("data-ihm-blocked");
    expect(d.html).toContain(`src="${TRACKER}"`);
  });

  it("applies the same decision when replying", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, imagePolicy: "ask" } });
    mailState(withRemoteImage(RECEIVED));
    const key = await useCompose.getState().reply(withRemoteImage(RECEIVED), "reply");
    const d = useCompose.getState().drafts.find((x) => x.key === key)!;
    expect(d.html).toContain("data-ihm-blocked");
    expect(d.html).not.toContain(`src="${TRACKER}"`);
  });
});

describe("compose as new", () => {
  it("keeps every recipient the message had, bcc included", async () => {
    const d = await draftFor(SENT);
    expect(d.to).toEqual([{ name: "Ann", email: "ann@example.com" }]);
    expect(d.cc).toEqual([{ name: null, email: "cc@example.com" }]);
    expect(d.bcc).toEqual([{ name: null, email: "bcc@example.com" }]);
    // Fields with something in them are shown, or the copy is invisible.
    expect([d.showCc, d.showBcc]).toEqual([true, true]);
  });

  it("keeps the subject as it stands, with no Re: or Fwd: on it", async () => {
    const d = await draftFor(SENT);
    expect(d.subject).toBe("Quarterly numbers");
  });

  it("keeps the reply-to the message carried", async () => {
    const d = await draftFor(SENT);
    expect(d.replyTo).toEqual([{ name: null, email: "desk@example.org" }]);
    expect(d.showReplyTo).toBe(true);
  });

  it("keeps the body, unquoted and unwrapped", async () => {
    const d = await draftFor(SENT);
    expect(d.html).toContain("Here they are.");
    expect(d.html).not.toContain("ihm-quote");
    expect(d.html).not.toContain("blockquote");
    expect(d.html).not.toContain("Forwarded message");
  });

  it("keeps the attachments, by the blobs they already have", async () => {
    const d = await draftFor(SENT);
    expect(d.attachments.map((a) => a.name)).toEqual(["numbers.pdf", "logo.png"]);
    // A blobId and no error is what the send path needs to accept one.
    expect(d.attachments.every((a) => a.blobId && !a.error && a.progress === 100)).toBe(
      true,
    );
    expect(d.attachments[1]!.inline).toBe(true);
    expect(d.attachments[0]!.inline).toBe(false);
  });

  it("sends as the identity the message was sent from", async () => {
    const d = await draftFor(SENT);
    expect(d.identityId).toBe("i1");
  });

  it("falls back to the default identity for a message somebody else sent", async () => {
    const d = await draftFor(RECEIVED);
    expect(d.identityId).toBe("i2");
  });

  it("is not the message it came from, so sending cannot destroy it", async () => {
    const d = await draftFor(SENT);
    expect(d.draftId).toBeNull();
  });

  it("threads onto nothing and marks nothing", async () => {
    const d = await draftFor(SENT);
    expect(d.inReplyTo).toBeNull();
    expect(d.references).toBeNull();
    expect(d.relatedEmailId).toBeNull();
    expect(d.relatedKeyword).toBeNull();
  });

  it("adds no second signature to a body that already has one", async () => {
    const d = await draftFor(SENT);
    expect(d.signatureHtml).toBe("");
    expect(d.html).not.toContain("ihm-signature");
  });

  it("opens a separate draft each time, rather than reusing the last", async () => {
    const first = await draftFor(SENT);
    const second = await draftFor(SENT);
    expect(second.key).not.toBe(first.key);
    expect(useCompose.getState().drafts).toHaveLength(2);
  });
});
