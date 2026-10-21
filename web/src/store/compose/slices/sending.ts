import { errorMessage } from "@gilbert/shared/errors";
import { t as translate } from "@/lib/i18n";
import { formatScheduleTime } from "@/lib/schedule";
import { toast } from "@/ui/toast";
import { useContacts } from "../../contacts";
import { useMail } from "../../mail";
import { useScheduled } from "../../scheduled";
import { useSettings } from "../../settings";
import { identitiesFor } from "../outgoing";
import { autosaveTimers } from "../saves";
import { newMessageId, SendOutcomeUnknown, sendInternal } from "../send";
import type { ComposeGet, ComposeSet, ComposeState, Draft, SendTarget } from "../types";
import { UNDO_SEND_SECONDS } from "../types";

/**
 * What happens when Send is pressed: the undo window, the submission, and
 * taking a message back before it goes.
 *
 * A slice of the compose store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function sendingSlice(
  set: ComposeSet,
  get: ComposeGet,
): Pick<ComposeState, "send" | "flushPendingSends" | "undoSend"> {
  return {
    async send(key) {
      const found = get().drafts.find((x) => x.key === key);
      if (!found) return;
      const delay = UNDO_SEND_SECONDS;
      /*
       * Settled here, when Send is pressed, and carried to the submission: the
       * undo window is long enough to switch mailbox or sign out, and a send
       * that resolved these afterwards would go out from whichever mailbox is on
       * screen by then -- or from none at all. See `SendTarget`.
       */
      const mail = useMail.getState();
      const accountId = found.accountId || mail.accountId;
      const identities = accountId ? identitiesFor(accountId, mail) : [];
      const identity =
        identities.find((i) => i.id === found.identityId) ??
        mail.defaultIdentityFor(accountId);
      const target: SendTarget = {
        accountId,
        identity: identity ?? null,
        // The fallback is inside the capture rather than at the submission: a
        // message with no folder to land in would be created nowhere.
        sentId: mail.roleId("sent", accountId) ?? mail.roleId("inbox", accountId),
        draftsId: mail.roleId("drafts", accountId),
      };
      // A draft that already has a Message-ID has been sent before, and failed.
      const retry = Boolean(found.sendMessageId);
      const d: Draft = {
        ...found,
        sendMessageId: found.sendMessageId ?? newMessageId(identity?.email ?? ""),
      };
      // A schedule the user left sitting until it passed is just a send now.
      const scheduling = d.sendAt !== null && d.sendAt > Date.now();
      // Hide the composer immediately; actually send after the undo window.
      const t = autosaveTimers.get(key);
      if (t) window.clearTimeout(t);
      autosaveTimers.delete(key);
      set((s) => ({
        drafts: s.drafts.filter((x) => x.key !== key),
        activeKey: s.activeKey === key ? null : s.activeKey,
      }));
      const doSend = async () => {
        /*
         * The entry stays until the send settles. An attachment upload that lands
         * while the send is in flight patches this snapshot (`patchAtt`), and a
         * failure restores that patched draft rather than the one Send captured
         * -- otherwise a draft restored with `blobId: null` dead-ends on the next
         * Send ("Attachments are still uploading"). `started` marks the undo
         * window closed, so a late click on Undo cannot take back a send already
         * under way.
         */
        set((s) => {
          const p = s.pendingSends[key];
          return p
            ? { pendingSends: { ...s.pendingSends, [key]: { ...p, started: true } } }
            : {};
        });
        /** Put a failed send's draft back, without waiting for the toast action. */
        const openDraft = (snapshot: Draft, message: string, orphan = false) =>
          set((s) => ({
            drafts: s.drafts.some((x) => x.key === snapshot.key)
              ? s.drafts
              : [...s.drafts, { ...snapshot, error: message, sendOrphan: orphan }],
          }));
        let current = d;
        try {
          current = get().pendingSends[key]?.draft ?? d;
          const sent = await sendInternal(current, target, { retry });
          if (sent.alreadySent) {
            // A scheduled message that was already submitted still needs the
            // Scheduled folder re-read; the wording is the same either way.
            if (scheduling) void useScheduled.getState().load();
            toast.success(
              translate("This message had already been sent, so it wasn't sent again."),
            );
            return;
          }
          // Everyone written to who is not a contact yet, so they are suggested
          // on every device and not only in the browser that sent the message.
          // A scheduled message is submitted when Send is pressed, so it counts
          // as sent here; the account is the one Send was pressed under, which
          // is what keeps a group's correspondents out of the reader's book.
          if (useSettings.getState().settings.collectRecipients) {
            // The sending account's own addresses, resolved when Send was
            // pressed: the identities on screen may belong to another mailbox by
            // the time the undo window closes.
            const own = identities.map((i) => i.email);
            /*
             * Fire and forget on purpose: the message is already sent, and a
             * book that could not be written must not fail it. The store reports
             * its own refusal and its own failure on its error surface, so there
             * is nothing to swallow here.
             */
            void useContacts
              .getState()
              .collectRecipients([...d.to, ...d.cc, ...d.bcc], own, target.accountId);
          }
          toast.success(
            scheduling
              ? translate("Send scheduled for {when}", {
                  when: formatScheduleTime(new Date(d.sendAt!)),
                })
              : translate("Message sent"),
          );
        } catch (err) {
          // The freshest snapshot an upload may have patched while the send ran.
          current = get().pendingSends[key]?.draft ?? current;
          if (err instanceof SendOutcomeUnknown) {
            openDraft(current, err.message);
            toast.error(err.message, {
              action: { label: translate("Open draft"), onClick: () => get().focus(key) },
              duration: 30000,
            });
            return;
          }
          const leftOrphan =
            (err as { sendOutcomeOrphan?: boolean }).sendOutcomeOrphan === true;
          const message = errorMessage(err);
          openDraft(current, message, leftOrphan);
          toast.error(translate("Send failed: {error}", { error: message }), {
            action: { label: translate("Open draft"), onClick: () => get().focus(key) },
            duration: 15000,
          });
        } finally {
          set((s) => {
            const { [key]: _drop, ...rest } = s.pendingSends;
            return { pendingSends: rest };
          });
        }
      };
      // A scheduled send is already delayed, and cancelling it is a server-side
      // operation from the Scheduled folder -- holding it locally first would
      // only add a second, different kind of undo.
      if (scheduling) {
        await doSend();
        return;
      }
      /*
       * The toast names the mail so a burst of sends can be told apart, and the
       * undo it offers is addressed by the draft key -- the message's own id --
       * never by that subject: two different sends may carry the same one.
       */
      const subject = d.subject.trim();
      const toastId = toast.show(
        subject ? translate("Sending “{subject}”", { subject }) : translate("Sending…"),
        {
          duration: delay * 1000,
          progress: true,
          action: { label: translate("Undo"), onClick: () => get().undoSend(key) },
        },
      );
      const timer = window.setTimeout(() => void doSend(), delay * 1000);
      set((s) => ({
        pendingSends: {
          ...s.pendingSends,
          [key]: { timer, toastId, draft: d, started: false, run: doSend },
        },
      }));
    },
    async flushPendingSends() {
      // Only the sends still inside their undo window: one already started (the
      // window closed, the submission under way) must not be run a second time —
      // signing out mid-send would otherwise submit the same message twice.
      const pending = Object.values(get().pendingSends).filter((p) => !p.started);
      for (const p of pending) {
        window.clearTimeout(p.timer);
        toast.dismiss(p.toastId);
      }
      await Promise.all(pending.map((p) => p.run()));
    },
    undoSend(key) {
      const p = get().pendingSends[key];
      // `started` means the undo window has closed and the send is under way:
      // taking the draft back now would both send and restore it.
      if (!p || p.started) return;
      window.clearTimeout(p.timer);
      toast.dismiss(p.toastId);
      set((s) => {
        const { [key]: _drop, ...rest } = s.pendingSends;
        return {
          pendingSends: rest,
          drafts: [...s.drafts, p.draft],
          // Reopen the taken-back mail only when nothing else is open: a send you
          // take back must not pull you out of the draft you started while it was
          // in flight.
          activeKey: s.activeKey ?? key,
        };
      });
    },
  };
}
