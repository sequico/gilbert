import { client, setErrorMessage } from "@/jmap/client";
import type { Email, EmailAddress, Id, SetResponse } from "@/jmap/types";
import { sameAddress } from "@/lib/address";
import { uid } from "@/lib/format";
import { buildMdn, MDN_SENT_KEYWORD, mdnDecision } from "@/lib/mdn";
import { useMail } from "./mail";

/**
 * Send the read receipt the sender asked for.
 *
 * Stalwart has no `MDN/send` (RFC 9007 is not among its capabilities), so the
 * report is built as raw MIME and posted the long way round: upload it as a
 * blob, import it so it has an id, then submit it like any other message.
 *
 * Never call this without the user having chosen it for this message --
 * `mdnDecision` says whether it may even be offered.
 */
export async function sendReadReceipt(email: Email): Promise<void> {
  const mail = useMail.getState();
  const accountId = mail.accountId;
  if (!accountId) throw new Error("Not signed in");

  const decision = mdnDecision(email, mail.roleId("sent"));
  if (!decision.offer || !decision.to)
    throw new Error("No read receipt is due for this message");

  // Answer as whichever identity the message was addressed to, so the receipt
  // comes from the address the sender wrote to rather than a default that may
  // be a different persona entirely.
  const addressed = [...(email.to ?? []), ...(email.cc ?? []), ...(email.bcc ?? [])];
  const identity =
    mail.identities.find((i) => addressed.some((a) => sameAddress(a.email, i.email))) ??
    mail.identities[0];
  if (!identity) throw new Error("No sending identity available");

  const from: EmailAddress = { name: identity.name || null, email: identity.email };
  const host = window.location.hostname || "localhost";
  const mime = buildMdn({
    email,
    from,
    to: decision.to,
    finalRecipient: identity.email,
    reportingUa: `${host}; Gilbert 2.0`,
    now: new Date(),
    boundary: `==gilbert-${uid("b")}==`,
    messageId: `<${uid("mdn")}.${Date.now()}@${host}>`,
  });

  const blob = new Blob([mime], { type: "message/rfc822" });
  const uploaded = await client.upload(accountId, blob, { type: "message/rfc822" });

  // It has to live somewhere to be submitted; Sent is where it honestly
  // belongs, and Archive is the one other honest home. Inbox is deliberately
  // not among them: a receipt filed there reads as mail the reader received.
  const sentId = mail.roleId("sent") ?? mail.roleId("archive");
  if (!sentId) throw new Error("No folder to file the receipt in");
  const mdnId = await mail.importEml(uploaded.blobId, sentId, { $seen: true });
  if (!mdnId) throw new Error("The server would not accept the receipt");

  /*
   * **The record goes down before the receipt leaves.** `$mdnsent` is what
   * stops a later look -- or another client entirely -- from offering the same
   * receipt again, so writing it is the decision, and the submission is the
   * effect. The other order is what sends a receipt more than once: a flaky
   * connection fails the mark after the submission has already gone, the
   * message stays offerable, and every further look offers it again -- one
   * confirmation to the sender per attempt.
   *
   * The mark is idempotent and harmless on its own: a keyword set twice is the
   * same keyword. So the failure this order introduces -- marked, and the
   * receipt did not go -- is the one that can be repaired, and it is repaired
   * below rather than left as a claim.
   */
  if (sendingReceipts.has(email.id))
    throw new Error("A read receipt for this message is already on its way");
  sendingReceipts.add(email.id);
  try {
    await markDecision(accountId, email.id);
  } catch (err) {
    sendingReceipts.delete(email.id);
    // Nothing left the process, and the message is still offerable: the reader
    // can try again, and no receipt exists twice.
    throw err;
  }

  let res: Map<string, Record<string, unknown>[]>;
  try {
    res = await client.chain(
      [
        [
          "EmailSubmission/set",
          {
            accountId,
            create: {
              s: {
                identityId: identity.id,
                emailId: mdnId,
                envelope: {
                  mailFrom: { email: identity.email },
                  rcptTo: [{ email: decision.to.email }],
                },
              },
            },
          },
          "s",
        ],
      ],
      { allowErrors: true },
    );
  } finally {
    sendingReceipts.delete(email.id);
  }

  const sub = res.get("s")?.[0] as unknown as
    | (SetResponse & { __error?: { type: string; description?: string } })
    | undefined;
  /*
   * The submission is the receipt: no response at all means it did not go.
   *
   * Every failure from here clears the mark again, because the mark is the
   * record that a receipt exists -- and none does. Undoing it is best-effort
   * by nature (the server may be the reason we are here), so a clearing that
   * also fails is reported rather than swallowed: the message is then marked
   * with no receipt behind it, which is the safe direction to err in and the
   * reader is told which one they are in.
   */
  const didNotGo = async (detail: string): Promise<never> => {
    let cleared = true;
    try {
      await clearDecision(accountId, email.id);
    } catch {
      cleared = false;
    }
    throw new Error(
      cleared
        ? detail
        : `${detail} — and this message is still marked as answered, so it will not offer the receipt again`,
    );
  };
  if (!sub) return didNotGo("The server would not accept the receipt");
  if (sub.__error) return didNotGo(setErrorMessage(sub.__error));
  if (sub.notCreated?.s) {
    // Do not leave an unsent receipt sitting in Sent looking like it went.
    void client.call("Email/set", { accountId, destroy: [mdnId] });
    return didNotGo(setErrorMessage(sub.notCreated.s));
  }

  markSent(email.id);
  void mail.loadMailboxes();
}

/**
 * A receipt is being sent for this message right now.
 *
 * The banner's own button is disabled while it works, but that state is the
 * view's and a re-mount loses it: navigating away and back, or opening the
 * message in a second tab, would otherwise start a second submission for a
 * message the first one has not finished with. One guard per message, here,
 * where the effect is.
 */
const sendingReceipts = new Set<Id>();

/** Write the keyword that records the decision, before the receipt leaves. */
async function markDecision(accountId: Id, emailId: Id): Promise<void> {
  const res = await client.call<SetResponse>("Email/set", {
    accountId,
    update: { [emailId]: { [`keywords/${MDN_SENT_KEYWORD}`]: true } },
  });
  const err = res.notUpdated?.[emailId];
  if (err) throw new Error(setErrorMessage(err));
  // Locally too, so a second look inside this session does not offer it while
  // the server read catches up.
  markSent(emailId);
}

/** Take the decision back: no receipt exists, so the message says none does. */
async function clearDecision(accountId: Id, emailId: Id): Promise<void> {
  const res = await client.call<SetResponse>("Email/set", {
    accountId,
    update: { [emailId]: { [`keywords/${MDN_SENT_KEYWORD}`]: null } },
  });
  const err = res.notUpdated?.[emailId];
  if (err) throw new Error(setErrorMessage(err));
  useMail.setState((s) => {
    const cur = s.emails[emailId];
    if (!cur) return {};
    const keywords = { ...cur.keywords };
    delete keywords[MDN_SENT_KEYWORD];
    return { emails: { ...s.emails, [emailId]: { ...cur, keywords } } };
  });
}

/** Reflect the keyword locally so the banner goes at once. */
function markSent(emailId: Id): void {
  useMail.setState((s) => {
    const cur = s.emails[emailId];
    if (!cur) return {};
    return {
      emails: {
        ...s.emails,
        [emailId]: { ...cur, keywords: { ...cur.keywords, [MDN_SENT_KEYWORD]: true } },
      },
    };
  });
}
