import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, client } from "@/jmap/client";
import { sendOutcomeUnknown, UNDO_SEND_SECONDS, useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";
import { useToasts } from "@/ui/toast";

/**
 * Sending once, whatever goes wrong on the way back.
 *
 * A send whose reply goes missing may still have gone out. "Send failed ->
 * Open draft -> Send" then delivered it twice: nothing said which message the
 * first attempt was, so nothing could check. Each send now carries its own
 * Message-ID, and an unanswered send asks the server what happened to it
 * before calling it failed.
 */

type Mode =
  | "ok"
  | "lost-reply"
  | "never-arrived"
  | "orphan"
  | "gateway"
  | "refused"
  | "offline-after";

interface Server {
  emails: { id: string; messageId: string }[];
  submissions: { id: string; emailId: string }[];
  destroyed: string[];
  creates: number;
}

const chainCalls: Array<Array<[string, Record<string, unknown>, string]>> = [];
const queried: string[] = [];

/** Install a fake Stalwart over the client, and return what it was asked to do. */
function server(mode: Mode, opts: { destroyFails?: boolean } = {}): Server {
  const st: Server = { emails: [], submissions: [], destroyed: [], creates: 0 };
  let first = true;
  let offline = false;
  const createEmail = (calls: Array<[string, Record<string, unknown>, string]>) => {
    const set = calls.find(([n, a]) => n === "Email/set" && a.create);
    const m = (set?.[1].create as { m: { messageId: string[] } } | undefined)?.m;
    if (!m) return;
    const id = `e${st.emails.length + 1}`;
    st.creates++;
    st.emails.push({ id, messageId: m.messageId[0]! });
  };
  const createSubmission = () => {
    const emailId = st.emails[st.emails.length - 1]!.id;
    st.submissions.push({ id: `s${emailId}`, emailId });
  };
  vi.spyOn(client, "chain").mockImplementation((async (
    calls: Array<[string, Record<string, unknown>, string]>,
  ) => {
    chainCalls.push(calls);
    const sending = calls.some(([n]) => n === "EmailSubmission/set");
    if (sending && first && mode !== "ok") {
      first = false;
      if (mode === "never-arrived") throw new TypeError("Failed to fetch");
      if (mode === "gateway") throw new ApiError(502, "bad_gateway");
      if (mode === "refused") throw new ApiError(400, "bad_request");
      // The server did the work; only the answer was lost.
      createEmail(calls);
      if (mode !== "orphan") createSubmission();
      if (mode === "offline-after") offline = true;
      throw new TypeError("Failed to fetch");
    }
    if (offline) throw new TypeError("Failed to fetch");
    const out = new Map<string, Record<string, unknown>[]>();
    for (const [method, args, id] of calls) {
      if (method === "Email/set" && args.create) {
        createEmail(calls);
        out.set(id, [
          {
            accountId: "a1",
            created: { m: { id: st.emails[st.emails.length - 1]!.id } },
          },
        ]);
      } else if (method === "EmailSubmission/set") {
        createSubmission();
        out.set(id, [
          {
            accountId: "a1",
            created: { s: { id: st.submissions[st.submissions.length - 1]!.id } },
          },
        ]);
      } else if (method === "Email/set" && args.destroy) {
        st.destroyed.push(...(args.destroy as string[]));
        out.set(id, [{ accountId: "a1", destroyed: args.destroy }]);
      } else {
        out.set(id, [{ accountId: "a1" }]);
      }
    }
    return out;
  }) as unknown as never);
  vi.spyOn(client, "call").mockImplementation((async (
    method: string,
    args: Record<string, unknown>,
  ) => {
    queried.push(method);
    if (offline) throw new TypeError("Failed to fetch");
    if (method === "Email/query") {
      const value = ((args.filter ?? {}) as { header?: [string, string] }).header?.[1];
      const ids = st.emails
        .filter((e) => e.messageId === value && !st.destroyed.includes(e.id))
        .map((e) => e.id);
      return { accountId: "a1", ids, total: ids.length };
    }
    if (method === "EmailSubmission/query") {
      const want = ((args.filter ?? {}) as { emailIds?: string[] }).emailIds ?? [];
      const ids = st.submissions.filter((s) => want.includes(s.emailId)).map((s) => s.id);
      return { accountId: "a1", ids, total: ids.length };
    }
    if (method === "Email/set" && args.destroy) {
      if (opts.destroyFails) throw new ApiError(500, "destroy_failed");
      st.destroyed.push(...(args.destroy as string[]));
      return { accountId: "a1", destroyed: args.destroy };
    }
    return { accountId: "a1" };
  }) as unknown as never);
  return st;
}

const toastTexts = () => useToasts.getState().toasts.map((t) => t.message);

const jane = { id: "i1", name: "John", email: "john@example.org", replyTo: null };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
  chainCalls.length = 0;
  queried.length = 0;
  useCompose.setState({ drafts: [], activeKey: null, pendingSends: {} });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  useMail.setState({
    accountId: "a1",
    identities: [jane] as never,
    mailboxes: {
      mbSent: { id: "mbSent", role: "sent", parentId: null, name: "Sent" },
      mbDrafts: { id: "mbDrafts", role: "drafts", parentId: null, name: "Drafts" },
    } as never,
    list: null,
    loadMailboxes: (async () => undefined) as never,
    refreshList: (async () => undefined) as never,
  });
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Let the awaits inside the send settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

async function sendOne(init: Record<string, unknown> = {}): Promise<string> {
  const key = useCompose.getState().open({
    identityId: "i1",
    to: [{ name: null, email: "ann@example.com" }],
    subject: "Hi",
    html: "<div>v1</div>",
    text: "v1",
    ...init,
  });
  void useCompose.getState().send(key);
  await vi.advanceTimersByTimeAsync(UNDO_SEND_SECONDS * 1000);
  await settle();
  return key;
}

describe("which failures leave the outcome open", () => {
  it("treats a refusal as not sent, and no answer or a gateway error as unknown", () => {
    expect(sendOutcomeUnknown(new ApiError(400, "bad"))).toBe(false);
    expect(sendOutcomeUnknown(new ApiError(401, "unauthenticated"))).toBe(false);
    expect(sendOutcomeUnknown(new ApiError(502, "bad_gateway"))).toBe(true);
    expect(sendOutcomeUnknown(new ApiError(408, "timeout"))).toBe(true);
    expect(sendOutcomeUnknown(new TypeError("Failed to fetch"))).toBe(true);
  });
});

describe("sending once, whatever goes wrong on the way back", () => {
  it("gives every send a Message-ID on the sender's domain", async () => {
    const st = server("ok");
    await sendOne();
    expect(st.emails).toHaveLength(1);
    expect(st.emails[0]!.messageId).toMatch(/^[0-9a-f-]{36}@example\.org$/);
    expect(toastTexts()).toContain("Message sent");
  });

  it("calls it sent when the reply was lost but the server sent it", async () => {
    const st = server("lost-reply");
    await sendOne();
    expect(st.submissions).toHaveLength(1);
    expect(st.destroyed).toEqual([]);
    expect(toastTexts()).toContain("Message sent");
    expect(useCompose.getState().drafts).toHaveLength(0);
  });

  it("removes a message that was created but never submitted, and says it failed", async () => {
    const st = server("orphan");
    await sendOne();
    expect(st.destroyed).toEqual(["e1"]);
    expect(toastTexts().some((t) => t.startsWith("Send failed"))).toBe(true);
  });

  it("says it failed when the request never reached the server", async () => {
    const st = server("never-arrived");
    await sendOne();
    expect(st.emails).toHaveLength(0);
    expect(toastTexts().some((t) => t.startsWith("Send failed"))).toBe(true);
  });

  it("asks the server after a gateway error too, rather than assuming", async () => {
    const st = server("gateway");
    await sendOne();
    expect(st.creates).toBe(0);
    expect(queried).toContain("Email/query");
    expect(toastTexts().some((t) => t.startsWith("Send failed"))).toBe(true);
  });

  it("does not ask after a refusal: the server did not run it", async () => {
    server("refused");
    await sendOne();
    expect(queried).not.toContain("Email/query");
  });

  it("says plainly when it cannot tell, instead of offering a resend that could duplicate", async () => {
    server("offline-after");
    await sendOne();
    const msgs = toastTexts();
    expect(
      msgs.some((t) => t.includes("Couldn't confirm whether this message was sent")),
    ).toBe(true);
    expect(msgs.some((t) => t.startsWith("Send failed"))).toBe(false);
  });
});

describe("sending a draft again after a failure", () => {
  it("keeps the Message-ID, and sends nothing when the first attempt went out", async () => {
    const st = server("ok");
    // The first attempt went out; the client never heard.
    st.emails.push({ id: "e1", messageId: "fixed@example.org" });
    st.submissions.push({ id: "se1", emailId: "e1" });
    await sendOne({ sendMessageId: "fixed@example.org" });
    expect(st.creates).toBe(0);
    expect(toastTexts().some((t) => t.includes("had already been sent"))).toBe(true);
  });

  it("sends it, under the same Message-ID, when the first attempt did not go out", async () => {
    const st = server("ok");
    await sendOne({ sendMessageId: "fixed@example.org" });
    expect(st.creates).toBe(1);
    expect(st.emails[0]!.messageId).toBe("fixed@example.org");
    expect(toastTexts()).toContain("Message sent");
  });

  it("reopens a failed draft with its Message-ID, so the next send can check", async () => {
    server("orphan");
    await sendOne();
    const toast = useToasts
      .getState()
      .toasts.find((t) => t.message.startsWith("Send failed"))!;
    toast.action!.onClick();
    const reopened = useCompose.getState().drafts[0]!;
    expect(reopened.sendMessageId).toMatch(/@example\.org$/);
  });

  it("destroys the copy it never submitted, then sends, when the retry knows it is unsent", async () => {
    const st = server("ok");
    // The first attempt created the message and never submitted it, and the
    // copy survived because the cleanup could not be confirmed.
    st.emails.push({ id: "e1", messageId: "fixed@example.org" });
    await sendOne({ sendMessageId: "fixed@example.org", sendOrphan: true });
    expect(st.destroyed).toEqual(["e1"]);
    expect(st.creates).toBe(1);
    expect(toastTexts()).toContain("Message sent");
  });

  it("remembers a copy it could not remove, so the retry does not call it sent", async () => {
    server("orphan", { destroyFails: true });
    await sendOne();
    const toast = useToasts
      .getState()
      .toasts.find((t) => t.message.startsWith("Send failed"))!;
    toast.action!.onClick();
    const reopened = useCompose.getState().drafts[0]!;
    expect(reopened.sendOrphan).toBe(true);
  });
});
