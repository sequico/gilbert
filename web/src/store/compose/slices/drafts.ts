import { errorMessage } from "@gilbert/shared/errors";
import { client } from "@/jmap/client";
import type { EmailAddress } from "@/jmap/types";
import { formatAddress, sameAddress, uniqueAddresses } from "@/lib/address";
import { emlFilename } from "@/lib/emlName";
import { formatFullDate, uid } from "@/lib/format";
import { sanitizeEmailHtml } from "@/lib/html";
import { t as translate } from "@/lib/i18n";
import { shareBody } from "@/lib/shareTarget";
import { escapeHtml, htmlToText, replySubject, textToHtml } from "@/lib/text";
import { toast } from "@/ui/toast";
import { useMail } from "../../mail";
import { settings } from "../../settings";
import {
  blankDraft,
  bodyFromEmail,
  defaultIdentity,
  hasContent,
  identityBcc,
  isContentPatch,
  quoteAllowsRemote,
  quoteTextOf,
  signatureBlock,
} from "../draft";
import {
  autosaveTimers,
  drainSaves,
  enqueueSave,
  saveChains,
  saveDraftInternal,
  scheduleAutosave,
} from "../saves";
import type { ComposeAttachment, ComposeGet, ComposeSet, ComposeState } from "../types";

/**
 * What a person does to a draft: open one, answer a message, write, save,
 * close.
 *
 * A slice of the compose store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function draftsSlice(
  set: ComposeSet,
  get: ComposeGet,
): Pick<
  ComposeState,
  | "open"
  | "openFromShare"
  | "openDraftEmail"
  | "composeAsNew"
  | "reply"
  | "forwardAsAttachment"
  | "update"
  | "close"
  | "focus"
  | "saveDraft"
> {
  return {
    open(init = {}) {
      const identities = useMail.getState().identities;
      const ident = init.identityId
        ? identities.find((i) => i.id === init.identityId)
        : useMail.getState().defaultIdentity();
      const bcc = identityBcc(ident, init.bcc ?? []);
      const d = blankDraft({
        identityId: ident?.id ?? null,
        replyTo: ident?.replyTo ?? [],
        showReplyTo: Boolean(ident?.replyTo?.length),
        ...init,
        // After the caller's own fields: the identity's address is added to
        // whatever this draft was addressed with, not replaced by it.
        bcc,
        showBcc: Boolean(bcc.length) || Boolean(init.showBcc),
      });
      if (!init.html && !init.text && ident) {
        d.signatureHtml = signatureBlock(ident, "html");
        d.html = `<div><br></div>${d.signatureHtml}`;
        d.text = signatureBlock(ident, "text");
      }
      set((s) => ({
        drafts: [
          ...s.drafts.map((x) => ({
            ...x,
            minimized: s.drafts.length >= 1 ? x.minimized : x.minimized,
          })),
          d,
        ],
        activeKey: d.key,
      }));
      return d.key;
    },
    /*
     * A share from the operating system, as a message being written.
     *
     * The subject and body are filled in but nothing is addressed and nothing is
     * sent: a share says what to send, never who to. What arrives is somebody
     * part-way through a thought, and the composer is where the rest of it goes.
     *
     * Opened empty first and the body pushed in above afterwards, rather than
     * passed to `open()`. `open()` only fits a signature when it is given no
     * body at all, so handing it the shared text would quietly drop the
     * signature from every message that started as a share.
     */
    openFromShare(share) {
      const body = shareBody(share);
      const key = get().open({ subject: share.title.trim() });
      if (body) {
        const d = get().drafts.find((x) => x.key === key);
        if (d)
          get().update(key, {
            html: `<div>${textToHtml(body)}</div>${d.html}`,
            text: `${body}\n${d.text}`,
          });
      }
      if (share.files.length) get().addFiles(key, share.files);
      return key;
    },
    async openDraftEmail(email) {
      const existing = get().drafts.find((d) => d.draftId === email.id);
      if (existing) {
        get().focus(existing.key);
        return existing.key;
      }
      const full = (await useMail.getState().getEmails([email.id], true))[0] ?? email;
      const identities = useMail.getState().identities;
      const ident =
        identities.find((i) => full.from?.some((f) => sameAddress(f.email, i.email))) ??
        useMail.getState().defaultIdentity() ??
        identities[0];
      const body = bodyFromEmail(full, useMail.getState().accountId!);
      const d = blankDraft({
        draftId: full.id,
        identityId: ident?.id ?? null,
        to: full.to ?? [],
        cc: full.cc ?? [],
        // The draft's own recipients, and not the identity's Bcc as well: this
        // draft was written once, and what it carries is what it was written
        // with (`identityBcc`).
        bcc: full.bcc ?? [],
        replyTo: full.replyTo ?? ident?.replyTo ?? [],
        showReplyTo: Boolean(full.replyTo?.length || ident?.replyTo?.length),
        showCc: Boolean(full.cc?.length),
        showBcc: Boolean(full.bcc?.length),
        subject: full.subject ?? "",
        ...body,
        inReplyTo: full.inReplyTo ?? null,
        references: full.references ?? null,
      });
      set((s) => ({ drafts: [...s.drafts, d], activeKey: d.key }));
      return d.key;
    },
    /*
     * The same mail again, as a mail that has never been sent.
     *
     * Not a forward and not a reply: a mail that was rejected, or went to an
     * address with a typo in it, is one you want to send *again* rather than pass
     * on. So there is no Fwd: on the subject, no quote wrapper around the body,
     * and the recipients it already had are the recipients it keeps.
     *
     * What makes it new is what is left out. `draftId` stays null, or sending
     * would destroy the message this was made from; `inReplyTo`, `references`,
     * `relatedEmailId` and `relatedKeyword` stay null, so nothing is threaded
     * onto the old message and the old message is not marked answered or
     * forwarded by sending this. The Message-ID and the date are the server's and
     * `buildEmailObject`'s respectively, and neither is copied from anywhere, so
     * both are new without anything here asking for it.
     */
    async composeAsNew(email) {
      const mail = useMail.getState();
      const full = (await mail.getEmails([email.id], true))[0] ?? email;
      const identities = mail.identities.length
        ? mail.identities
        : await mail.loadIdentities();
      // Sent by you, so send it as you again -- the same rule that reopens a
      // draft. A mail somebody else sent has no identity of yours to match, and
      // guessing from who it was addressed to would put a resend behind an alias
      // that was only ever the receiving end; the account's own default is the
      // honest answer there.
      const ident =
        identities.find((i) => full.from?.some((f) => sameAddress(f.email, i.email))) ??
        mail.defaultIdentity() ??
        identities[0];
      const body = bodyFromEmail(full, mail.accountId!);
      const d = blankDraft({
        identityId: ident?.id ?? null,
        to: full.to ?? [],
        cc: full.cc ?? [],
        bcc: identityBcc(ident, full.bcc ?? []),
        // The message's own Reply-To if it carried one, which is the setting the
        // report asks to keep; the identity's only when it did not.
        replyTo: full.replyTo ?? ident?.replyTo ?? [],
        showReplyTo: Boolean(full.replyTo?.length || ident?.replyTo?.length),
        showCc: Boolean(full.cc?.length),
        showBcc: Boolean(full.bcc?.length || ident?.bcc?.length),
        subject: full.subject ?? "",
        ...body,
        // No signature is added, and `signatureHtml` is left empty on purpose.
        // The body is the sent one, which already ends in whatever signature it
        // was sent with; appending the identity's would give it two.
      });
      set((st) => ({ drafts: [...st.drafts, d], activeKey: d.key }));
      return d.key;
    },
    async reply(email, mode) {
      const mail = useMail.getState();
      const full = (await mail.getEmails([email.id], true))[0] ?? email;
      const identities = mail.identities.length
        ? mail.identities
        : await mail.loadIdentities();
      const ident = defaultIdentity(identities, full);
      const ownEmails = identities.map((i) => i.email);
      /* `sameAddress` rather than a lowercased `includes`, because an identity
       address can carry whitespace and a hand-typed one does. */
      const isOwn = (a: EmailAddress) => ownEmails.some((e) => sameAddress(e, a.email));
      const withoutOwn = (list: EmailAddress[]) =>
        uniqueAddresses(list).filter((a) => !isOwn(a));
      const s = settings();

      /*
       * Was this message mine?
       *
       * The folder answers it before the addresses do, and has to: the address
       * test fails in exactly the cases where the mistake is least visible. A
       * message sent from an alias or a shared mailbox that `Identity/get` does
       * not list is not recognisably mine, and neither is anything at all if the
       * identities have not loaded yet -- and the failure is silent, addressing
       * the reply back to me with everyone I actually wrote to moved to Cc.
       *
       * A message in Sent is mine whatever address it went out as.
       */
      const sentId = mail.roleId("sent");
      const sentByMe =
        (Boolean(full.from?.length) && (full.from ?? []).every(isOwn)) ||
        Boolean(sentId && full.mailboxIds?.[sentId]);

      let to: EmailAddress[] = [];
      let cc: EmailAddress[] = [];
      if (mode === "reply" || mode === "replyAll") {
        /*
         * Who a plain reply answers, and who a reply all answers.
         *
         * A plain reply reaches **one** partner, and that is the whole difference
         * between the two actions -- the one a reader can see in the draft, since
         * reply all is the action that puts a list there. It is the sender, their
         * Reply-To first, that being what that header is for.
         *
         * A message of mine has no sender to answer, so the one partner is the
         * person I wrote to -- and my own address when the message went nowhere
         * else, because an empty To is worse than the only address there was.
         * Reaching all of them is what Reply all is for.
         */
        const senders = uniqueAddresses(
          full.replyTo?.length ? full.replyTo : (full.from ?? []),
        );
        const others = withoutOwn(
          uniqueAddresses([...(full.to ?? []), ...(full.cc ?? [])]),
        );
        if (mode === "reply") {
          to = (sentByMe ? (others.length ? others : senders) : senders).slice(0, 1);
        } else if (sentByMe && (full.to?.length || full.cc?.length)) {
          /*
           * Replying to something I sent continues the conversation with the
           * people I wrote to. Not with myself, and not with my own Reply-To
           * either -- that address is where replies *to me* belong, and following
           * it here would send my own reply to my own desk.
           */
          to = withoutOwn(full.to ?? []);
          cc = withoutOwn(full.cc ?? []);
          // Addressed only to myself, or only in Cc: there is still somebody this
          // is a reply to, and an empty To is not it.
          if (!to.length) {
            to = cc;
            cc = [];
          }
          if (!to.length) to = uniqueAddresses([...(full.to ?? []), ...(full.cc ?? [])]);
        } else {
          to = senders;
          cc = others.filter((a) => !to.some((t) => sameAddress(t.email, a.email)));
        }
      }

      const htmlPart = full.htmlBody?.[0];
      const textPart = full.textBody?.[0];
      const origHtml = htmlPart?.partId
        ? (full.bodyValues?.[htmlPart.partId]?.value ?? "")
        : "";
      const origText = textPart?.partId
        ? (full.bodyValues?.[textPart.partId]?.value ?? "")
        : "";
      const accountId = mail.accountId!;
      const attachments: ComposeAttachment[] = [];
      const cidMap: Record<string, string> = {};
      for (const a of full.attachments ?? []) {
        const inline = Boolean(a.cid) && a.type.startsWith("image/");
        if (inline && a.cid && a.blobId)
          cidMap[a.cid] = client.downloadUrl(
            accountId,
            a.blobId,
            a.name ?? "image",
            a.type,
            true,
          );
        if (mode === "forward" || inline) {
          attachments.push({
            id: uid("a"),
            name: a.name ?? "attachment",
            type: a.type,
            size: a.size,
            blobId: a.blobId,
            progress: 100,
            error: null,
            cid: a.cid ?? undefined,
            inline,
          });
        }
      }
      // Inline images are shown via their blob URLs in the editor and converted back to cid: at send time.
      //
      // `<style>` blocks go: what comes out of here is quoted into the composer,
      // which is a live document of ours and not a scoped view of a message, so a
      // style block carried in with the quote would restyle the app around it.
      const quotedHtmlBody = origHtml
        ? sanitizeEmailHtml(origHtml, {
            cidMap,
            allowRemote: quoteAllowsRemote(full.from?.[0]),
            proxyRemote: false,
            stripStyleBlocks: true,
          }).html
        : textToHtml(origText).replace(/\n/g, "<br>");
      const fromStr = escapeHtml((full.from ?? []).map(formatAddress).join(", "));
      const date = formatFullDate(full.receivedAt);
      /*
       * `ihm-quote` for the same reason as `ihm-signature` above: it is a class
       * in a body this product sent and Stalwart kept. Reply-with-quote and
       * reply-as-new both find it by that class, in the messages sent before
       * this rename as well as after it, so the one name both eras agree on is
       * the one to keep.
       */
      let quoteHtml = "";
      let quoteTxt = "";
      if (mode === "forward") {
        const hdr = [
          `From: ${(full.from ?? []).map(formatAddress).join(", ")}`,
          `Date: ${date}`,
          `Subject: ${full.subject ?? ""}`,
          `To: ${(full.to ?? []).map(formatAddress).join(", ")}`,
          ...(full.cc?.length ? [`Cc: ${full.cc.map(formatAddress).join(", ")}`] : []),
        ];
        quoteHtml = `<div class="ihm-quote"><br><div>---------- Forwarded message ---------</div><div>${hdr.map(escapeHtml).join("<br>")}</div><br>${quotedHtmlBody}</div>`;
        quoteTxt = `\n\n---------- Forwarded message ---------\n${hdr.join("\n")}\n\n${origText || (origHtml ? htmlToText(origHtml) : "")}`;
      } else if (s.includeQuote) {
        quoteHtml = `<div class="ihm-quote"><br><div>On ${escapeHtml(date)}, ${fromStr} wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${quotedHtmlBody}</blockquote></div>`;
        quoteTxt = `\n\nOn ${date}, ${(full.from ?? []).map(formatAddress).join(", ")} wrote:\n${quoteTextOf(origText, origHtml)}`;
      }
      const sigHtml = signatureBlock(ident, "html");
      const sigText = signatureBlock(ident, "text");
      const html = s.signatureAboveQuote
        ? `<div><br></div>${sigHtml}${quoteHtml}`
        : `<div><br></div>${quoteHtml}${sigHtml}`;
      const text = s.signatureAboveQuote
        ? `${sigText}${quoteTxt}`
        : `${quoteTxt}${sigText}`;
      const messageId = full.messageId?.[0];
      const d = blankDraft({
        identityId: ident?.id ?? null,
        to,
        cc,
        showCc: cc.length > 0,
        replyTo: ident?.replyTo ?? [],
        showReplyTo: Boolean(ident?.replyTo?.length),
        bcc: identityBcc(ident),
        showBcc: Boolean(ident?.bcc?.length),
        subject: replySubject(full.subject, mode === "forward" ? "Fwd" : "Re"),
        html,
        text,
        format: s.composeFormat,
        attachments,
        inReplyTo: mode === "forward" ? null : messageId ? [messageId] : null,
        references:
          mode === "forward"
            ? null
            : messageId
              ? [...(full.references ?? []), messageId]
              : (full.references ?? null),
        relatedEmailId: full.id,
        relatedKeyword: mode === "forward" ? "$forwarded" : "$answered",
        signatureHtml: sigHtml,
        replyMode: mode,
      });
      set((st) => ({ drafts: [...st.drafts, d], activeKey: d.key }));
      return d.key;
    },
    forwardAsAttachment(email) {
      const accountId = useMail.getState().accountId;
      const key = get().open({
        subject: replySubject(email.subject, "Fwd"),
        relatedEmailId: email.id,
        relatedKeyword: "$forwarded",
        replyMode: "forward",
      });
      // A message's own blobId *is* its RFC822 blob, and it already lives in this
      // account -- so this goes through the same path as attach-from-Files and
      // uploads nothing at all, however large the message.
      //
      // It inherits that path's size check as well, which is measured against
      // `maxSizeUpload` even though nothing is being uploaded. That is worth
      // knowing rather than working around here: the check belongs to
      // `addFromFiles` and applies to every by-reference attachment, so if it is
      // wrong it is wrong in one place and should be fixed there.
      if (accountId) {
        void get().addFromFiles(key, [
          {
            accountId,
            name: emlFilename(email.subject),
            type: "message/rfc822",
            size: email.size,
            blobId: email.blobId,
          },
        ]);
      }
      return key;
    },
    update(key, patch) {
      set((s) => ({
        drafts: s.drafts.map((d) =>
          d.key === key
            ? { ...d, ...patch, dirty: patch.dirty ?? (d.dirty || isContentPatch(patch)) }
            : d,
        ),
      }));
      if (isContentPatch(patch)) scheduleAutosave(key, get);
    },
    async close(key, opts = {}) {
      const d = get().drafts.find((x) => x.key === key);
      if (!d) return;
      const t = autosaveTimers.get(key);
      if (t) window.clearTimeout(t);
      autosaveTimers.delete(key);
      for (const a of d.attachments) a.abort?.abort();
      set((s) => ({
        drafts: s.drafts.filter((x) => x.key !== key),
        activeKey:
          s.activeKey === key
            ? (s.drafts.find((x) => x.key !== key)?.key ?? null)
            : s.activeKey,
      }));
      if (opts.discard) {
        /*
         * A save that was in flight when the draft closed may still create the
         * next draft; destroying the id captured here would leave that one
         * behind. Wait for the saves, then destroy the draft the last one
         * actually produced.
         */
        try {
          await drainSaves(key);
          const q = saveChains.get(key);
          const id = q?.lastId ?? d.draftId;
          saveChains.delete(key);
          if (id) {
            await client.call("Email/set", {
              accountId: d.accountId,
              destroy: [id],
            });
            void useMail.getState().refreshList();
            void useMail.getState().loadMailboxes();
          }
        } catch {
          /* ignore */
        }
        toast.show(translate("Draft discarded"));
        return;
      }
      if (d.dirty && (d.to.length || d.subject || hasContent(d))) {
        try {
          // Queued behind any save already running, so the final copy is written
          // after it and replaces the draft it created rather than racing it.
          await enqueueSave(key, () =>
            saveDraftInternal(d, get, set, { silent: true, final: true }),
          );
          saveChains.delete(key);
          toast.show(translate("Draft saved"));
        } catch (err) {
          /*
           * The draft left `drafts` before this save ran, so a failure would drop
           * it from the screen, from Drafts and from anything that could retry.
           * It goes back where the reader can see it, exactly as a failed send
           * restores its own.
           */
          set((s) => ({
            drafts: s.drafts.some((x) => x.key === d.key) ? s.drafts : [...s.drafts, d],
            activeKey: d.key,
          }));
          toast.error(
            translate("Could not save draft: {error}", { error: errorMessage(err) }),
          );
        }
      } else {
        saveChains.delete(key);
      }
    },
    focus(key) {
      set((s) => ({
        activeKey: key,
        drafts: s.drafts.map((d) => (d.key === key ? { ...d, minimized: false } : d)),
      }));
    },
    async saveDraft(key, opts = {}) {
      try {
        return await enqueueSave(key, async () => {
          // Read at run time, not at queue time: whatever the user typed while an
          // earlier save was in flight is what this one must persist.
          const d = get().drafts.find((x) => x.key === key);
          if (!d) return null;
          return saveDraftInternal(d, get, set, { silent: opts.silent ?? false });
        });
      } catch (err) {
        if (!opts.silent)
          toast.error(
            translate("Could not save draft: {error}", { error: errorMessage(err) }),
          );
        return null;
      }
    },
  };
}
