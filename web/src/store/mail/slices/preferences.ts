import { errorMessage } from "@gilbert/shared/errors";
import { CAP, client, setErrorMessage } from "@/jmap/client";
import type { GetResponse, Quota, SetResponse, VacationResponse } from "@/jmap/types";
import type { MailGet, MailSet, MailState } from "../types";

/**
 * Vacation and quota: the two settings the server holds.
 *
 * A slice of the mail store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function preferencesSlice(
  set: MailSet,
  get: MailGet,
): Pick<MailState, "loadVacation" | "saveVacation" | "loadQuota"> {
  return {
    async loadVacation() {
      const accountId = get().accountId;
      if (!accountId) return;
      try {
        const res = await client.call<GetResponse<VacationResponse>>(
          "VacationResponse/get",
          { accountId, ids: null },
        );
        set({ vacation: res.list[0] ?? null, vacationError: null });
      } catch (err) {
        /*
         * What was known is kept and the failure is said. `null` here means the
         * server answered that there is no out-of-office response, and dressing a
         * failed read as that answer turns the settings page into a form that is
         * off and empty when the account may well be answering everybody with a
         * message — and whose Save then writes that emptiness over it. A server
         * without the vacation capability refuses this call too, so it lands here
         * rather than in a branch of its own: the same answer, said the same way.
         */
        set({ vacationError: errorMessage(err) });
      }
    },

    async saveVacation(patch) {
      const accountId = get().accountId!;
      const res = await client.call<SetResponse>("VacationResponse/set", {
        accountId,
        update: { singleton: patch },
      });
      const err = res.notUpdated?.singleton;
      if (err) throw new Error(setErrorMessage(err));
      await get().loadVacation();
    },

    async loadQuota() {
      const accountId = get().accountId;
      if (!accountId || !client.hasCapability(CAP.quota)) return;
      // Claimed before the read, so a second ask from the bar's effect answers
      // itself instead of sending a second request for the account already on its
      // way. A quick switch back is caught by the guard after the await.
      set({ quotaAccountId: accountId });
      try {
        const res = await client.call<GetResponse<Quota>>("Quota/get", {
          accountId,
          ids: null,
        });
        if (get().accountId !== accountId) return;
        set({ quotas: res.list });
      } catch {
        if (get().accountId !== accountId) return;
        set({ quotas: [] });
      }
    },
  };
}
