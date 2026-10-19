import { create } from "zustand";
import { mailAccountCandidates } from "@/lib/mailAccounts";
import { useSession } from "../session";
import { accountSlice } from "./slices/account";
import { changesSlice } from "./slices/changes";
import { identitiesSlice } from "./slices/identities";
import { labelsSlice } from "./slices/labels";
import { listingSlice } from "./slices/listing";
import { mailboxesSlice } from "./slices/mailboxes";
import { preferencesSlice } from "./slices/preferences";
import { selectionSlice } from "./slices/selection";
import { writesSlice } from "./slices/writes";
import type { MailState } from "./types";

export const useMail = create<MailState>((set, get) => ({
  accountId: null,
  ownAccountId: null,
  mailAccounts: [],
  accountTrees: {},
  mailboxes: {},
  mailboxState: null,
  mailboxesLoaded: false,
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
  labelCounts: {},
  selectedAll: false,
  anchorId: null,
  loadingThreads: {},
  lastSeenInboxEmailIds: null,
  lastThreadEmailIds: [],
  openThreadId: null,

  ...accountSlice(set, get),
  ...mailboxesSlice(set, get),
  ...listingSlice(set, get),
  ...writesSlice(set, get),
  ...identitiesSlice(set, get),
  ...preferencesSlice(set, get),
  ...labelsSlice(set, get),
  ...selectionSlice(set, get),
  ...changesSlice(set, get),
}));

/**
 * The store's account is its own. Group mailboxes open without moving the
 * session's selected account, which the other stores read to stay on the
 * reader's own data (settings, Sieve) -- the mistake a whole-app account
 * switcher makes. So this binds to the sign-in *state*, not to the session's
 * account id: a session refresh must not yank the reader out of a group
 * mailbox they are looking at.
 */
useSession.subscribe((s, prev) => {
  if (s.status !== prev.status) {
    const mail = useMail.getState();
    if (s.status !== "authenticated") {
      mail.setAccount(null);
      return;
    }
    const own = mailAccountCandidates(s.session).find((c) => c.kind === "own");
    mail.setAccount(own?.accountId ?? null);
    void mail.discoverMailAccounts();
    return;
  }
  /*
   * A group the Master is added to or taken out of is a new or a missing tab
   * on the agent's page, and a group mailbox the composer opens: the session's
   * accounts are asked again on every refresh. The probe skips by itself when
   * the accounts it knows are still the session's candidates.
   */
  if (s.status === "authenticated" && s.session !== prev.session)
    void useMail.getState().discoverMailAccounts();
});

export { BODIES_KEPT, releaseBodies, resetBodyOrder } from "./bodies";
export { mailboxIcon, ROLE_ORDER, rememberedMailAccount } from "./folders";
export { DEFAULT_SORT } from "./list";
export { notifyGroupMail } from "./notify";
export type { ListQuery, ListState, MailState } from "./types";
export { BODY_PROPS, FULL_PROPS, LIST_PROPS, MAILBOX_PROPS } from "./types";
