import { client } from "@/jmap/client";
import type { GetResponse, Id, Mailbox } from "@/jmap/types";
import { forgetOpenAccounts } from "@/lib/accountFold";
import { placeOwnerFrom, rememberPlace } from "@/lib/lastPlace";
import { type MailAccountInfo, mailAccountCandidates } from "@/lib/mailAccounts";
import { useSession } from "../../session";
import { resetBodyOrder } from "../bodies";
import { rememberedMailAccount } from "../folders";
import { adoptMailboxes } from "../mailboxes";
import type { MailGet, MailSet, MailState } from "../types";
import { MAILBOX_PROPS } from "../types";

/**
 * The account lifecycle: which account is on screen, and how a
 * mailbox account is discovered and opened.
 *
 * A slice of the mail store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function accountSlice(
  set: MailSet,
  get: MailGet,
): Pick<
  MailState,
  | "setOpenThread"
  | "setAccount"
  | "discoverMailAccounts"
  | "refreshAccountTree"
  | "openAccount"
> {
  /** The discovery run already on its way, shared by every caller that joins it. */
  let discoverInFlight: Promise<void> | null = null;

  return {
    setOpenThread(id) {
      set({ openThreadId: id });
    },

    setAccount(accountId) {
      if (accountId === get().accountId) return;
      /*
       * The account being left behind had its own unfolded accounts; every
       * other one starts folded under the account now in front. Neither boot
       * nor sign-out is such a switch: there is no account on the other side
       * of it, and what the device remembered stands as it was left.
       */
      if (get().accountId && accountId)
        forgetOpenAccounts(placeOwnerFrom(useSession.getState()));
      // Nothing held in full belongs to the account being left behind.
      resetBodyOrder();
      /*
       * The folder tree of the account being opened, when this session has
       * already read it: kept in `accountTrees` for exactly this. The probe
       * refreshes it a moment later, but the sidebar is that account's own
       * column -- blanking it for the round trip is the whole left side of the
       * window disappearing and drawing itself again on every switch. A first
       * visit has no tree yet and waits, which is honest.
       */
      const cachedTree = accountId ? get().accountTrees[accountId] : undefined;
      set({
        accountId,
        /* The per-account state below belongs to whichever account is active.
         The sidebar trees and the account list outlive a switch -- they are
         what let the reader come back -- and are dropped only on sign-out. */
        ...(accountId
          ? {
              ownAccountId: get().ownAccountId,
              mailAccounts: get().mailAccounts,
              accountTrees: get().accountTrees,
            }
          : { ownAccountId: null, mailAccounts: [], accountTrees: {} }),
        mailboxes: cachedTree ?? {},
        mailboxState: null,
        mailboxesLoaded: Boolean(cachedTree),
        emails: {},
        fullIds: {},
        emailState: null,
        threads: {},
        identities: [],
        identitiesByAccount: {},
        assignmentByAccount: {},
        quotas: [],
        quotaAccountId: null,
        vacation: null,
        vacationError: null,
        list: null,
        selected: {},
        selectedAll: false,
        anchorId: null,
        lastSeenInboxEmailIds: null,
        /* The rest names objects of the account that was on screen: ids of its
         own, a label count from its folders, a conversation, a thread. Kept,
         they would be read against the folders of the new account. */
        labelCounts: {},
        loadingThreads: {},
        lastThreadEmailIds: [],
        openThreadId: null,
      });
    },

    /*
     * Which accounts carry a mailbox: the reader's own, then the group mailboxes
     * whose folder trees `Mailbox/get` answers with. Each candidate is asked for
     * its folders; an account that shares only calendars, books or files answers
     * with none and is not listed (see lib/mailAccounts).
     *
     * A session refresh can land at any moment, so this must be cheap when
     * nothing changed: probing every account on every refresh would turn the
     * session's own change beat into a loop. Skip when the candidate list is
     * already the one on screen, and share the probe that is already on its
     * way, so overlapping callers get one round of Mailbox/get -- and its
     * answer -- rather than a second caller returning as if it had one.
     */
    async discoverMailAccounts() {
      if (discoverInFlight) return discoverInFlight;
      discoverInFlight = (async () => {
        try {
          const session = useSession.getState().session;
          const candidates = mailAccountCandidates(session);
          const current = get().mailAccounts;
          /*
           * Skip only when every account already known is still among the
           * candidates. Comparing the two lengths instead would never skip: a
           * candidate list holds every non-personal account, while `mailAccounts`
           * holds only the ones the probe found to be mailboxes, so a single
           * calendar/files/address-book share makes the lists different for ever
           * and the probe runs on every beat.
           */
          const byCandidate = new Map(candidates.map((c) => [c.accountId, c]));
          if (
            current.length > 0 &&
            current.every((a) => {
              const c = byCandidate.get(a.accountId);
              return c?.kind === a.kind && c.name === a.name;
            })
          )
            return;
          const ownInfo = candidates.find((c) => c.kind === "own") ?? null;
          const groups: MailAccountInfo[] = [];
          const trees: Record<Id, Record<Id, Mailbox>> = {};
          for (const c of candidates) {
            if (c.kind !== "group") continue;
            try {
              const res = await client.call<GetResponse<Mailbox>>("Mailbox/get", {
                accountId: c.accountId,
                ids: null,
                properties: MAILBOX_PROPS,
              });
              if (!res.list.length) continue;
              trees[c.accountId] = adoptMailboxes(c.accountId, res.list);
              groups.push(c);
            } catch {
              /*
               * A probe that failed is not an answer. `Mailbox/get` is what
               * proves an account carries a mailbox, but a request that never
               * answered proves nothing -- and dropping the account on it would
               * take the group off the screen, which is how its whole membership
               * ends up in the From list. The entry already known for that
               * account is kept instead; an answer with no folder tree still
               * drops it, just above.
               */
              const known = current.find((a) => a.accountId === c.accountId);
              if (known) groups.push(known);
            }
          }
          /*
           * The answer belongs to the session it was asked of. A sign-out, or a
           * fresh session, can land while the probe is in flight, and writing
           * this one then would put the previous reader's accounts back on
           * screen under the new session.
           */
          if (useSession.getState().session !== session) return;
          set((s) => ({
            ownAccountId: ownInfo?.accountId ?? null,
            mailAccounts: ownInfo ? [ownInfo, ...groups] : [],
            accountTrees: { ...s.accountTrees, ...trees },
          }));
          /*
           * The group mailboxes are known here, and with them that the reader
           * may need a group's From list narrowed to the identity assigned to
           * them there. Read now so the composer has it before a draft is
           * opened, and for the account on screen at that moment.
           */
          const active = get().accountId;
          if (active)
            void get()
              .loadAssignmentFor(active)
              .catch(() => undefined);
          /*
           * The account the reader was last on, if it is still one of theirs.
           * Discovery is where the group mailboxes become known, so this is the
           * first moment a remembered group account could be honoured at all --
           * the account switcher has nothing to offer before it.
           */
          const again = rememberedMailAccount(get().mailAccounts);
          if (again && again !== get().accountId) void get().openAccount(again);
        } finally {
          discoverInFlight = null;
        }
      })();
      return discoverInFlight;
    },

    async refreshAccountTree(accountId) {
      try {
        const res = await client.call<GetResponse<Mailbox>>("Mailbox/get", {
          accountId,
          ids: null,
          properties: MAILBOX_PROPS,
        });
        const tree = adoptMailboxes(accountId, res.list);
        set((s) => ({ accountTrees: { ...s.accountTrees, [accountId]: tree } }));
      } catch {
        /* keep the last tree we could read */
      }
    },

    async openAccount(accountId) {
      if (!accountId) return;
      /*
       * Where the reader is, for the next session on this device. Recorded here
       * rather than in `setAccount`, because the boot sequence and the sign-in
       * path call that too: a place is somewhere somebody went, and the account a
       * session opens on by itself is not one they chose.
       */
      rememberPlace(placeOwnerFrom(useSession.getState()), { mailAccountId: accountId });
      if (accountId === get().accountId) {
        if (!get().mailboxesLoaded) await get().loadMailboxes();
        return;
      }
      get().setAccount(accountId);
      await Promise.all([get().loadMailboxes(), get().loadIdentities()]);
      void get().loadQuota();
    },
  };
}
