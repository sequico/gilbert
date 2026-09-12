import { client, setErrorMessage } from "@/jmap/client";
import type { Email, EmailAddress, Id, SetResponse } from "@/jmap/types";
import { sameAddress } from "@/lib/address";
import { uid } from "@/lib/format";
import { t as translate } from "@/lib/i18n";
import { buildMdn, MDN_SENT_KEYWORD, mdnDecision } from "@/lib/mdn";
import { toast } from "@/ui/toast";
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

  const res = await client.chain(
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
      // RFC 3503's keyword, set on the original rather than remembered locally,
      // so a second look -- or another client entirely -- knows not to ask again.
      [
        "Email/set",
        { accountId, update: { [email.id]: { [`keywords/${MDN_SENT_KEYWORD}`]: true } } },
        "k",
      ],
    ],
    { allowErrors: true },
  );

  const sub = res.get("s")?.[0] as unknown as
    | (SetResponse & { __error?: { type: string; description?: string } })
    | undefined;
  // The submission is the receipt: no response at all means it did not go.
  if (!sub) throw new Error("The server would not accept the receipt");
  if (sub.__error) throw new Error(setErrorMessage(sub.__error));
  if (sub.notCreated?.s) {
    // Do not leave an unsent receipt sitting in Sent looking like it went.
    void client.call("Email/set", { accountId, destroy: [mdnId] });
    throw new Error(setErrorMessage(sub.notCreated.s));
  }

  /*
   * The submission succeeding is only half the record: the `$mdnsent` keyword
   * on the original is what stops a later look (or another client) from
   * offering the receipt again. Inspecting only the submission response lets a
   * failed mark send the receipt and leave it offerable -- and a reload then
   * produces a duplicate. Try the mark again; if that also
   * fails, say so rather than pretending the message is recorded.
   */
  const mark = res.get("k")?.[0] as unknown as SetResponse & {
    __error?: { type: string; description?: string };
  };
  if (mark?.__error || mark?.notUpdated?.[email.id]) {
    try {
      const retry = await client.call<SetResponse>("Email/set", {
        accountId,
        update: { [email.id]: { [`keywords/${MDN_SENT_KEYWORD}`]: true } },
      });
      const err = retry.notUpdated?.[email.id];
      if (err) throw new Error(setErrorMessage(err));
    } catch {
      toast.show(
        translate(
          "The receipt was sent, but recording that on the original message failed — you may be asked about it again.",
        ),
      );
    }
  }

  markSent(email.id);
  void mail.loadMailboxes();
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
