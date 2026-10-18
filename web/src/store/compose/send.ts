import { client, setErrorMessage } from "@/jmap/client";
import type { Email, Id, SetResponse } from "@/jmap/types";
import { uniqueAddresses } from "@/lib/address";
import { t as translate } from "@/lib/i18n";
import { formatScheduleTime } from "@/lib/schedule";
import { toast } from "@/ui/toast";
import { useMail } from "../mail";
import { destroyEmails as destroyEmailsBatched } from "../mail/mutations";
import { ensureScheduledMailbox, useScheduled } from "../scheduled";
import { buildEmailObject, buildSubmission, sendOutcomeUnknown } from "./outgoing";
import { drainSaves, saveChains } from "./saves";
import type { Draft, SendTarget } from "./types";

/**
 * A send whose outcome nobody can state: the request went out, no answer came
 * back, and the server could not be asked afterwards either. Offering a plain
 * "send again" here is how one message is delivered twice.
 */
export class SendOutcomeUnknown extends Error {}

/** A Message-ID for one send, on the sending identity's domain (RFC 5322 §3.6.4). */
export function newMessageId(fromEmail: string): string {
  const domain = fromEmail.split("@")[1] || "localhost";
  return `${crypto.randomUUID()}@${domain}`;
}
/**
 * Destroy a set of messages and report whether the server confirmed it. Used
 * for the copy a failed send created; a refusal is not fatal here, only the
 * reason to stop trusting that the copy is gone. `mail/mutations` splits the
 * call into what the server takes, and a per-object refusal comes back in the
 * answer rather than as a throw, so the answer is read as well as the throw.
 */
async function destroyEmails(accountId: Id, ids: Id[]): Promise<boolean> {
  if (!ids.length) return true;
  try {
    const { notDestroyed } = await destroyEmailsBatched(accountId, ids);
    return Object.keys(notDestroyed).length === 0;
  } catch {
    return false;
  }
}

/**
 * What became of a send with this Message-ID.
 *
 * `sent`: a message carrying it exists and was submitted. `orphan`: it exists
 * but no submission does, so it was created and never sent. `none`: nothing.
 *
 * Stalwart expunges submissions after its hold period, so "no submission"
 * means unsent only right after the attempt (`justNow`). Later, a message
 * still carrying the id is taken as sent: every path that fails a send
 * destroys the copy it created.
 */
async function traceSend(
  accountId: Id,
  messageId: string,
  justNow: boolean,
): Promise<{ trace: "sent" | "orphan" | "none"; emailIds: Id[] }> {
  const q = await client.call<{ ids: Id[] }>("Email/query", {
    accountId,
    filter: { header: ["Message-ID", messageId] },
  });
  const emailIds = q.ids ?? [];
  if (!emailIds.length) return { trace: "none", emailIds };
  if (!justNow) return { trace: "sent", emailIds };
  const subs = await client.call<{ ids: Id[] }>("EmailSubmission/query", {
    accountId,
    filter: { emailIds },
  });
  return { trace: subs.ids?.length ? "sent" : "orphan", emailIds };
}

export async function sendInternal(
  d: Draft,
  target: SendTarget,
  opts: { retry?: boolean } = {},
): Promise<{ alreadySent?: boolean }> {
  const mail = useMail.getState();
  const accountId = target.accountId;
  if (!accountId) throw new Error(translate("Not signed in"));
  /*
   * Only a session missing stops a send here. The account, the persona and the
   * folders were resolved when Send was pressed and travel in `target`, so
   * opening another mailbox inside the undo window is a change of view and not
   * an Undo: the message goes out from the mailbox it was written in, with the
   * identity it was written as. A reader who signed out has nothing left to
   * submit it with, and there the draft comes back.
   */
  if (!mail.accountId) throw new Error(translate("Not signed in"));
  const ident = target.identity;
  if (!ident) throw new Error(translate("No sending identity available"));
  if (d.attachments.some((a) => !a.blobId && !a.error))
    throw new Error(translate("Attachments are still uploading"));
  /*
   * A save that was in flight when Send was clicked may still be creating the
   * draft this message replaces. Wait for it, and destroy the draft it
   * actually produced -- otherwise its create lands after this destroy and a
   * $draft of the sent message is left behind.
   */
  await drainSaves(d.key);
  const draftId = saveChains.get(d.key)?.lastId ?? d.draftId;
  saveChains.delete(d.key);
  const scheduled = d.sendAt !== null && d.sendAt > Date.now();
  const scheduledId = scheduled ? await ensureScheduledMailbox(accountId) : null;
  const email = await buildEmailObject(d, {
    forSend: true,
    mailboxId: scheduledId,
    send: target,
  });
  const messageId = d.sendMessageId ?? newMessageId(ident.email);
  email.messageId = [messageId];
  /*
   * Sending again a draft that came back from a failed send: ask first. The
   * failure may have been only the reply going missing, and a second
   * submission would deliver the message twice.
   */
  if (opts.retry) {
    let found: Awaited<ReturnType<typeof traceSend>>;
    try {
      // A retry of a draft that left an unsent copy asks about the submission;
      // one back from an unknown outcome reads any surviving copy as sent, a
      // submission possibly expunged since.
      found = await traceSend(accountId, messageId, Boolean(d.sendOrphan));
    } catch {
      throw new SendOutcomeUnknown(
        translate(
          "Couldn't check whether this message was already sent. Check Sent before sending it again.",
        ),
      );
    }
    if (found.trace === "sent") {
      if (draftId) await destroyEmails(accountId, [draftId]);
      void mail.loadMailboxes();
      void mail.refreshList();
      return { alreadySent: true };
    }
    // The copy this send left behind and never submitted: remove it, then send.
    if (found.trace === "orphan" && found.emailIds.length)
      await destroyEmails(accountId, found.emailIds);
  }
  const sentId = target.sentId;
  const draftsId = target.draftsId;
  const rcpts = uniqueAddresses([...d.to, ...d.cc, ...d.bcc]).map((a) => ({
    email: a.email,
  }));
  if (!rcpts.length) throw new Error(translate("No recipients"));
  const sub = buildSubmission({
    identityId: ident.id,
    fromEmail: ident.email,
    emailRef: "#m",
    rcpts,
    sentId,
    draftsId,
    scheduledId,
    sendAt: scheduled ? d.sendAt : null,
  });
  const calls: Array<[string, Record<string, unknown>, string]> = [
    [
      "Email/set",
      { accountId, create: { m: email }, ...(draftId ? { destroy: [draftId] } : {}) },
      "e",
    ],
    [
      "EmailSubmission/set",
      {
        accountId,
        create: { s: sub.create },
        onSuccessUpdateEmail: { "#s": sub.onSuccessUpdateEmail },
      },
      "s",
    ],
  ];
  if (d.relatedEmailId && d.relatedKeyword) {
    calls.push([
      "Email/set",
      {
        accountId,
        update: { [d.relatedEmailId]: { [`keywords/${d.relatedKeyword}`]: true } },
      },
      "k",
    ]);
  }
  let res: Awaited<ReturnType<typeof client.chain>>;
  try {
    res = await client.chain(calls, { allowErrors: true });
  } catch (err) {
    if (!sendOutcomeUnknown(err)) throw err;
    // No answer is not a no: find out what the server did with it.
    let found: Awaited<ReturnType<typeof traceSend>>;
    try {
      found = await traceSend(accountId, messageId, true);
    } catch {
      throw new SendOutcomeUnknown(
        translate(
          "Couldn't confirm whether this message was sent. Check Sent before sending it again.",
        ),
      );
    }
    if (found.trace === "sent") {
      void mail.loadMailboxes();
      void mail.refreshList();
      return {};
    }
    // Created but never submitted: take it out of Sent, then report the
    // failure. If it cannot be removed, mark the failure so the next send
    // destroys it and sends again instead of reading it as proof it went out.
    if (found.trace === "orphan") {
      const cleaned = await destroyEmails(accountId, found.emailIds);
      if (!cleaned) (err as { sendOutcomeOrphan?: boolean }).sendOutcomeOrphan = true;
    }
    throw err;
  }
  const e = res.get("e")?.[0] as unknown as SetResponse<Email> & {
    __error?: { type: string; description?: string };
  };
  if (e.__error) throw new Error(setErrorMessage(e.__error));
  if (e.notCreated?.m) throw new Error(setErrorMessage(e.notCreated.m));
  const s = res.get("s")?.[0] as unknown as SetResponse & {
    __error?: { type: string; description?: string };
  };
  if (s.__error || s.notCreated?.s) {
    // The submission failed, so the message the chain created never left: it is
    // destroyed rather than left looking sent, whether the refusal was
    // per-object or for the whole call. If it cannot be removed, mark the
    // failure so the next send destroys it and sends again, instead of reading
    // a surviving copy as proof the message went out.
    const created = e.created?.m?.id;
    const refusal = s.__error ?? s.notCreated?.s;
    const error = new Error(
      refusal ? setErrorMessage(refusal) : "the message could not be submitted",
    );
    if (created && !(await destroyEmails(accountId, [created])))
      (error as { sendOutcomeOrphan?: boolean }).sendOutcomeOrphan = true;
    throw error;
  }
  if (d.relatedEmailId && d.relatedKeyword) {
    useMail.setState((st) => {
      const cur = st.emails[d.relatedEmailId!];
      return cur
        ? {
            emails: {
              ...st.emails,
              [d.relatedEmailId!]: {
                ...cur,
                keywords: { ...cur.keywords, [d.relatedKeyword!]: true },
              },
            },
          }
        : {};
    });
  }
  if (scheduled) {
    // The server decides the release time, so take its word for it rather than
    // ours -- and say so if the two disagree, which means the hold did not land
    // the way we asked.
    const created = (s.created?.s ?? {}) as {
      id?: Id;
      sendAt?: string;
      undoStatus?: string;
    };
    const settled = created.sendAt ? Date.parse(created.sendAt) : NaN;
    if (!Number.isNaN(settled) && Math.abs(settled - d.sendAt!) > 60_000) {
      toast.error(
        translate("The server scheduled this for {when}, not the time requested.", {
          when: formatScheduleTime(new Date(settled)),
        }),
      );
    }
    await useScheduled.getState().load();
  }
  void mail.loadMailboxes();
  void mail.refreshList();
  return {};
}
