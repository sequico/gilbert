import { groupSenderIdentity } from "@gilbert/shared/identityAssignment";
import { client, setErrorMessage } from "@/jmap/client";
import type { GetResponse, Id, Identity, SetResponse } from "@/jmap/types";
import { t } from "@/lib/i18n";
import {
  isGroupMailboxAccount,
  mailAccountAddress,
  ownIdentityAccountId,
} from "@/lib/mailAccounts";
import { useSession } from "../../session";
import { settings, useSettings } from "../../settings";
import {
  EMPTY_IDENTITIES,
  identitiesLoading,
  identitiesReads,
  overtakeIdentities,
  sortIdentities,
} from "../identities";
import type { MailGet, MailSet, MailState } from "../types";

/**
 * From addresses, and which one is the reader's in each account.
 *
 * A slice of the mail store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function identitiesSlice(
  set: MailSet,
  get: MailGet,
): Pick<
  MailState,
  | "loadIdentitiesFor"
  | "loadIdentities"
  | "loadAssignmentFor"
  | "defaultIdentity"
  | "defaultIdentityFor"
  | "ownIdentities"
  | "setDefaultIdentity"
  | "saveIdentity"
  | "destroyIdentity"
  | "refreshIdentities"
> {
  /**
   * The active account's From list, as `identities`.
   *
   * `identities` is one *view* of `identitiesByAccount`, and this is what makes
   * it one: the account on screen, narrowed where the account on screen is a
   * group mailbox. ADR 0005 gives a group's account one identity per member,
   * and a member sends as the identity the administration **assigned** them —
   * else as the group's own, which is what the agent sends as too, so nobody is
   * left without a sender and no member ever sends under another's name.
   * Everywhere but a group the view is the account's list, whole.
   *
   * Rebuilt from the cache rather than patched, so a stale entry -- an identity
   * destroyed in another client, a list that landed after the reader switched --
   * cannot survive in the view.
   */
  function applyIdentities(accountId: Id): void {
    const state = get();
    if (state.accountId !== accountId) return;
    const all = state.identitiesByAccount[accountId] ?? [];
    if (!isGroupMailboxAccount(accountId, state.mailAccounts)) {
      set({ identities: all });
      return;
    }
    /*
     * The cascade lives once, in `@gilbert/shared/identityAssignment`, and is
     * imported rather than restated: the identity assigned to the reader, else
     * the group's own, matched by the address the session calls this account.
     *
     * An assignment that has not been read is no assignment — `held?.assignedId`
     * — so one call answers both before and after the read, and what stands in
     * while it is on its way is step 2 of the cascade: what the answer will be
     * for a member nothing is assigned to anyway. The alternative is an empty
     * From, which the composer reports as a group that holds no identity, a
     * claim that is false for as long as the read takes.
     */
    const held = state.assignmentByAccount[accountId];
    const sender = groupSenderIdentity(
      all,
      held?.assignedId,
      mailAccountAddress(state.mailAccounts, accountId),
    );
    set({ identities: sender ? [sender] : [] });
  }

  /**
   * A cache entry moved: recompute what is on screen from it.
   *
   * Two entries can move the view -- the account being browsed, and the reader's
   * own list, which is what tells a group mailbox which of its identities is
   * theirs -- so a change to either recomputes the active view.
   */
  function identitiesChanged(accountId: Id): void {
    applyIdentities(accountId);
    const active = get().accountId;
    if (!active || active === accountId) return;
    if (accountId === ownIdentityAccountId(useSession.getState().session))
      applyIdentities(active);
  }

  return {
    async loadIdentitiesFor(accountId) {
      if (!accountId) return [];
      const running = identitiesLoading.get(accountId);
      if (running) return running;
      /*
       * The number this read is started under. A write that lands while it is on
       * its way spends it (`overtakeIdentities`), and what it got is then kept
       * between the reader and this promise rather than written under the
       * account -- the list it holds is the one from before the write.
       */
      const read = identitiesReads.get(accountId) ?? 0;
      const spent = () => (identitiesReads.get(accountId) ?? 0) !== read;
      const run = (async () => {
        let res: GetResponse<Identity>;
        try {
          res = await client.call<GetResponse<Identity>>("Identity/get", {
            accountId,
            ids: null,
          });
        } catch {
          /*
           * A failed read is not an answer: the identities already cached for
           * this account stay, and the view keeps what it had — the account's own
           * identity, which is what an unassigned member sends as anyway. This is
           * read on every account switch, so a rejection here reached every
           * caller that fires a switch without awaiting it (the mail route, a
           * folder click) as an unhandled rejection.
           */
          return get().identitiesByAccount[accountId] ?? [];
        }
        /*
         * Cached under the account id, whatever is on screen. The account the
         * reader's own identities live in is rarely the one they are browsing --
         * somebody reading a group's mail is looking at the group's account --
         * and Settings lists the two one under the other, so each answer is kept
         * rather than thrown away with the account that asked for it.
         */
        let list = sortIdentities(res.list, accountId);
        if (spent()) return list;
        set((s) => ({
          identitiesByAccount: { ...s.identitiesByAccount, [accountId]: list },
        }));
        identitiesChanged(accountId);
        // Long signatures live in Files; swap the stored marker for the full HTML.
        const { markerOf } = await import("@/lib/signatureHtml");
        const pending = list.filter((i) => markerOf(i.htmlSignature));
        if (!pending.length) return list;
        const { loadStoredSignature } = await import("@/lib/signatureImages");
        const full = await Promise.all(
          pending.map(async (i) => {
            const m = markerOf(i.htmlSignature)!;
            try {
              return [i.id, await loadStoredSignature(m.blobId, m.type)] as const;
            } catch {
              return [i.id, null] as const;
            }
          }),
        );
        // The same account again: its signatures are as much part of its list as
        // of the list of the account that happens to be on screen.
        list = list.map((i) => {
          const f = full.find(([id]) => id === i.id)?.[1];
          return f ? { ...i, htmlSignature: f } : i;
        });
        if (spent()) return list;
        set((s) => ({
          identitiesByAccount: { ...s.identitiesByAccount, [accountId]: list },
        }));
        identitiesChanged(accountId);
        return list;
      })();
      identitiesLoading.set(accountId, run);
      try {
        return await run;
      } finally {
        // Only this read's own entry: a read started after it took the place,
        // and dropping that one would have a third caller fetch in parallel.
        if (identitiesLoading.get(accountId) === run) identitiesLoading.delete(accountId);
      }
    },

    async loadIdentities() {
      const accountId = get().accountId;
      if (!accountId) return [];
      await get().loadIdentitiesFor(accountId);
      /*
       * A group mailbox has one more thing to know before its view is right: the
       * identity the administration assigned the reader (ADR 0005). Read beside
       * the list rather than after it, and a failure is not fatal -- the view
       * falls back to the group's own identity, which is what an unassigned
       * member sends as anyway.
       */
      if (isGroupMailboxAccount(accountId, get().mailAccounts))
        await get()
          .loadAssignmentFor(accountId)
          .catch(() => undefined);
      // The account's *view*, which is what every caller of this has always had:
      // in a group mailbox the sender is the assigned identity, else the group's.
      return get().identities;
    },

    /**
     * Which identity this group mailbox has assigned to the reader (ADR 0005).
     *
     * `null` is an answer -- nothing is assigned, so the view sends as the
     * group's own identity -- and a failed read leaves the entry absent, which is
     * "not known", so an unreadable document is never shown as "nothing
     * assigned" outside the window where the group's own identity is what both
     * would offer anyway.
     */
    async loadAssignmentFor(accountId, opts) {
      const state = get();
      if (!isGroupMailboxAccount(accountId, state.mailAccounts)) return;
      if (!opts?.force && state.assignmentByAccount[accountId] !== undefined) return;
      const address = mailAccountAddress(state.mailAccounts, accountId);
      if (!address) return;
      const { fetchMemberAssignment } = await import("@/lib/identities");
      const view = await fetchMemberAssignment(address);
      set((s) => ({
        assignmentByAccount: {
          ...s.assignmentByAccount,
          [accountId]: { assignedId: view.assignedId },
        },
      }));
      identitiesChanged(accountId);
    },

    defaultIdentity() {
      const { identities, accountId } = get();
      /*
       * Through the one reader of the preference: the account a draft is written
       * in first, the reader's own behind it. `setDefaultIdentity` writes under
       * the account that sends for the reader, which is not always the account on
       * screen -- and a group mailbox has narrowed to the reader's own identity
       * by then, so the fallback there is the identity already being offered.
       */
      return (
        get().defaultIdentityFor(accountId) ??
        get().defaultIdentityFor(ownIdentityAccountId(useSession.getState().session)) ??
        identities[0]
      );
    },

    defaultIdentityFor(accountId) {
      if (!accountId) return undefined;
      /*
       * The account on screen is read from its view: in a group mailbox that
       * view is the reader's own identity, while the group account's own
       * preference may name a different member. Everything else comes from the
       * cache, which is where the reader's own list lives.
       */
      const list =
        accountId === get().accountId
          ? get().identities
          : (get().identitiesByAccount[accountId] ?? []);
      const pref = settings().defaultIdentityByAccount[accountId];
      return list.find((i) => i.id === pref) ?? list[0];
    },

    ownIdentities() {
      const own = ownIdentityAccountId(useSession.getState().session);
      if (!own) return EMPTY_IDENTITIES;
      return get().identitiesByAccount[own] ?? EMPTY_IDENTITIES;
    },

    setDefaultIdentity(id) {
      // ADR 0005: the default a person sets is the one their own account sends
      // with, not the preference of the mailbox they happened to be reading.
      const accountId = ownIdentityAccountId(useSession.getState().session);
      if (!accountId) return;
      useSettings.getState().update({
        defaultIdentityByAccount: {
          ...settings().defaultIdentityByAccount,
          [accountId]: id,
        },
      });
      const cached = get().identitiesByAccount[accountId] ?? [];
      if (cached.length)
        set((s) => ({
          identitiesByAccount: {
            ...s.identitiesByAccount,
            [accountId]: sortIdentities(cached, accountId),
          },
        }));
      const active = get().accountId;
      if (active) applyIdentities(active);
    },

    async saveIdentity(id, patch) {
      const accountId = ownIdentityAccountId(useSession.getState().session);
      if (!accountId) throw new Error(t("Not signed in"));
      const res = id
        ? await client.call<SetResponse<Identity>>("Identity/set", {
            accountId,
            update: { [id]: patch },
          })
        : await client.call<SetResponse<Identity>>("Identity/set", {
            accountId,
            create: { n: patch },
          });
      const err = id ? res.notUpdated?.[id] : res.notCreated?.n;
      if (err) throw new Error(setErrorMessage(err));
      // A read already on its way was asked before this write and answers with
      // the list from before it, so it is spent rather than joined.
      overtakeIdentities(accountId);
      await get().loadIdentitiesFor(accountId);
    },

    async destroyIdentity(id) {
      const accountId = ownIdentityAccountId(useSession.getState().session);
      if (!accountId) throw new Error(t("Not signed in"));
      const res = await client.call<SetResponse>("Identity/set", {
        accountId,
        destroy: [id],
      });
      const err = res.notDestroyed?.[id];
      if (err) throw new Error(setErrorMessage(err));
      // Same as saveIdentity: the list has to be read after the write.
      overtakeIdentities(accountId);
      await get().loadIdentitiesFor(accountId);
    },

    async refreshIdentities() {
      /*
       * Every list this session is holding, plus the two that are always worth
       * having: the reader's own, which Settings lists and a group mailbox
       * narrows against, and the account on screen.
       */
      const state = get();
      const own = ownIdentityAccountId(useSession.getState().session);
      const wanted = new Set<Id>(Object.keys(state.identitiesByAccount));
      if (own) wanted.add(own);
      if (state.accountId) wanted.add(state.accountId);
      /*
       * The assignments too, and dropped rather than kept: the administration
       * writes them through its own routes (ADR 0005), so the session that asked
       * for the write is the one thing that never hears of it — and a stale
       * assignment is a draft that goes out as the group instead of as the person
       * the administrator just assigned.
       */
      set({ assignmentByAccount: {} });
      for (const id of wanted) overtakeIdentities(id);
      await Promise.all(
        [...wanted].map((id) =>
          get()
            .loadIdentitiesFor(id)
            .catch(() => undefined),
        ),
      );
      if (state.accountId)
        await get()
          .loadAssignmentFor(state.accountId)
          .catch(() => undefined);
    },
  };
}
