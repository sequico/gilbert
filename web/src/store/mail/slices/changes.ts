import { errorMessage } from "@gilbert/shared/errors";
import { chunk, client, JmapMethodError, setErrorMessage } from "@/jmap/client";
import type { ChangesResponse, Email, GetResponse, Id } from "@/jmap/types";
import { ownIdentityAccountId } from "@/lib/mailAccounts";
import { useSession } from "../../session";
import { mergeEmail } from "../list";
import { notifyGroupMail, notifyNewMail } from "../notify";
import type { MailGet, MailSet, MailState } from "../types";
import { LIST_PROPS } from "../types";

/**
 * Bringing the store up to date when the server says what moved.
 *
 * A slice of the mail store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function changesSlice(
  set: MailSet,
  get: MailGet,
): Pick<MailState, "applyChanges" | "applyAccountChanges" | "importEml"> {
  /**
   * A failed `Email/changes` pass already reported, until one lands.
   *
   * A transient failure is left to heal on the next pass; a persistent one is
   * said once rather than on every push beat.
   */
  let changesReported = false;

  return {
    async applyChanges(types, signal) {
      const accountId = get().accountId;
      if (!accountId) return;
      // A pass aborted at the start is not worth a single request; one aborted
      // mid-way stops before each further call, because `client.call` rejects an
      // aborted signal without sending anything.
      if (signal?.aborted) return;
      if (types.has("Mailbox")) void get().loadMailboxes();
      if (types.has("Email")) {
        const state = get().emailState;
        if (state) {
          try {
            let since = state;
            let guard = 0;
            let more = false;
            const updated = new Set<Id>();
            const created = new Set<Id>();
            const destroyed = new Set<Id>();
            // Page through Email/changes.
            while (guard++ < 10) {
              const ch = await client.call<ChangesResponse>(
                "Email/changes",
                {
                  accountId,
                  sinceState: since,
                  maxChanges: 500,
                },
                [],
                signal,
              );
              ch.created.forEach((id) => created.add(id));
              ch.updated.forEach((id) => updated.add(id));
              ch.destroyed.forEach((id) => destroyed.add(id));
              since = ch.newState;
              if (!ch.hasMoreChanges) break;
              more = true;
            }
            // The changes were read: whatever was reported while the server was
            // failing has been answered, so a later failure is news again.
            changesReported = false;
            set((s) => {
              const next = { ...s.emails };
              const nextFull = { ...s.fullIds };
              for (const id of destroyed) {
                delete next[id];
                delete nextFull[id];
              }
              /*
               * The full copy of an updated email is deliberately kept.
               *
               * Dropping it would make the next read fetch it again, but the
               * reading pane renders only the emails it holds in full: dropping
               * one takes the message out of the open thread until the refetch
               * at the end of this function puts it back. The pane empties and
               * refills -- on an HTML message, a flash to the app's own
               * background and out again, which is what is left of #100.
               *
               * Marking as read causes exactly this: the server echoes our own
               * change back as an update.
               *
               * Nothing is lost by keeping it. RFC 8621 makes every property of
               * an Email immutable except `keywords` and `mailboxIds` -- the id
               * is derived from the content, so a body cannot change beneath one
               * -- and both are in LIST_PROPS, which the refresh immediately
               * below merges over the cached copy. Dropping it only ever costs
               * the message its place in the thread.
               */
              return { emails: next, fullIds: nextFull };
            });
            // Refresh the list-level props of updated/cached emails.
            const cached = [...updated].filter((id) => get().emails[id]);
            if (cached.length) {
              const results = await Promise.all(
                chunk(cached, client.maxObjectsInGet).map((part) =>
                  client.call<GetResponse<Email>>(
                    "Email/get",
                    {
                      accountId,
                      ids: part,
                      properties: LIST_PROPS,
                    },
                    [],
                    signal,
                  ),
                ),
              );
              set((s) => {
                const next = { ...s.emails };
                for (const r of results)
                  for (const e of r.list) next[e.id] = mergeEmail(next[e.id], e);
                return { emails: next };
              });
            }
            /*
             * The token moves only once every read the new state promised has
             * landed. An aborted pass (or a failed `Email/get`) leaves
             * `emailState` where it was, so the next pass asks for the same
             * window again rather than dropping the updated emails whose list
             * props were never fetched -- `refreshList` below re-reads ids only,
             * not those props.
             *
             * A walk that stopped at its page bound with changes still pending
             * never read them, and the token after them would claim it had: it
             * is taken from the server's own current state instead, and the
             * window is re-read, which is the same answer the chat store gives
             * its transcript.
             */
            if (more) {
              const now = await client.call<{ state?: unknown }>(
                "Email/get",
                { accountId, ids: [], properties: ["id"] },
                [],
                signal,
              );
              set({ emailState: typeof now.state === "string" ? now.state : null });
            } else {
              set({ emailState: since });
            }
            if (created.size) await notifyNewMail([...created], get);
          } catch (err) {
            if (err instanceof JmapMethodError && err.type === "cannotCalculateChanges") {
              /*
               * The token is older than the server's window: dropping it makes
               * the next pass start from the server's own state rather than
               * asking for a range that no longer exists.
               */
              set({ emailState: null });
            } else if (!signal?.aborted) {
              /*
               * Every other failure leaves the token where it was, so the same
               * window is asked for again -- a transient outage heals itself. A
               * pass that keeps failing is reported once, so an account whose
               * mail has stopped updating does not do so silently.
               */
              if (!changesReported) {
                changesReported = true;
                console.warn(
                  `[gilbert] could not read mail changes: ${errorMessage(err)}`,
                );
              }
            }
          }
        }
        // The list and the tree are next; an aborted pass leaves them to the
        // pass that follows the reconnection rather than firing requests now.
        if (signal?.aborted) return;
        void get().refreshList();
        void get().loadMailboxes();
      }
      if (signal?.aborted) return;
      if (types.has("Thread") || types.has("Email")) {
        const open = get().openThreadId;
        if (open)
          void get()
            .loadThread(open)
            .catch(() => undefined);
      }
      if (types.has("Identity")) {
        /*
         * Both lists are "on screen" in the ADR 0012 sense while Settings is
         * open: the account being browsed, and the reader's own, which is every
         * group block under it. A change to either is a change to what is shown.
         */
        const own = ownIdentityAccountId(useSession.getState().session);
        void get()
          .loadIdentitiesFor(accountId)
          .catch(() => undefined);
        if (own && own !== accountId)
          void get()
            .loadIdentitiesFor(own)
            .catch(() => undefined);
      }
      if (types.has("VacationResponse")) void get().loadVacation();
      if (types.has("Quota")) void get().loadQuota();
    },

    async applyAccountChanges(accountId, types, signal) {
      if (signal?.aborted) return;
      if (accountId === get().accountId) return get().applyChanges(types, signal);
      if (!get().mailAccounts.some((a) => a.accountId === accountId)) return;
      /*
       * A mailbox changed while the reader is elsewhere -- a group box under
       * their own, or their own while they are inside a group. Refresh its folder
       * tree so the sidebar's counts stay honest, and announce what it received
       * so a visible Gilbert is not the quiet one (ADR 0016).
       */
      void get().refreshAccountTree(accountId);
      // `notifyGroupMail` reads the message to announce; an aborted pass leaves
      // the announcement to the next one rather than fetching against nothing.
      if (signal?.aborted) return;
      if (types.has("Email"))
        await notifyGroupMail(accountId, get).catch(() => undefined);
    },

    async importEml(blobId, mailboxId, keywords = {}) {
      const accountId = get().accountId;
      if (!accountId) return null;
      const res = await client.call<{
        created?: Record<string, Email>;
        notCreated?: Record<string, { type: string; description?: string }>;
      }>("Email/import", {
        accountId,
        emails: { i: { blobId, mailboxIds: { [mailboxId]: true }, keywords } },
      });
      if (res.notCreated?.i) throw new Error(setErrorMessage(res.notCreated.i));
      void get().refreshList();
      void get().loadMailboxes();
      return res.created?.i?.id ?? null;
    },
  };
}
