import { client } from "@/jmap/client";
import type { Invocation } from "@/jmap/types";
import {
  countedKeywords,
  countsConversations,
  type KeywordCounts,
  SEEN_KEYWORD,
} from "@/lib/keywordCounts";
import { isGroupMailboxAccount } from "@/lib/mailAccounts";
import { labelsForAccount } from "../../groupLabels";
import { settings } from "../../settings";
import type { MailGet, MailSet, MailState } from "../types";

/**
 * The unread counts a folder tree draws.
 *
 * A slice of the mail store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function labelsSlice(
  set: MailSet,
  get: MailGet,
): Pick<MailState, "loadLabelCounts"> {
  return {
    async loadLabelCounts() {
      const accountId = get().accountId;
      const labels = labelsForAccount(accountId, settings().labels);
      /*
       * Starred is counted too, and it is not a label: it is the keyword a star
       * writes, drawn as the first row of the same list. An account with no
       * labels still has stars, so the empty case is the counted set being
       * empty and never the label array.
       */
      const keywords = countedKeywords(
        labels,
        isGroupMailboxAccount(accountId, get().mailAccounts),
      );
      if (!accountId) {
        if (Object.keys(get().labelCounts).length) set({ labelCounts: {} });
        return;
      }
      /*
       * Two queries per keyword -- the total, and the unread half -- carried in
       * slices of the server's batch ceiling. The count is the whole answer, so
       * `limit: 0` keeps the server from sending ids that would only be thrown
       * away: what is wanted is `total`.
       *
       * Both are asked at once rather than derived, because one cannot be
       * derived from the other and the sidebar needs both: the row shows the
       * total, and a label set to "while unread" is drawn or dropped by the
       * unread half.
       *
       * **`collapseThreads` is the setting the list itself uses**, so the number
       * counts the unit the reader is about to see: conversations when
       * conversation view is on, messages when it is off. Without it a
       * conversation of three messages carrying a label counted three while the
       * list it opened showed one row -- a number that contradicts the list it
       * describes is worse than no number.
       */
      const collapseThreads = countsConversations();
      const calls: Invocation[] = keywords.flatMap((keyword, i) => [
        [
          "Email/query",
          {
            accountId,
            filter: { hasKeyword: keyword },
            collapseThreads,
            limit: 0,
            calculateTotal: true,
          },
          `t${i}`,
        ],
        [
          "Email/query",
          {
            accountId,
            filter: {
              operator: "AND",
              conditions: [{ hasKeyword: keyword }, { notKeyword: SEEN_KEYWORD }],
            },
            collapseThreads,
            limit: 0,
            calculateTotal: true,
          },
          `u${i}`,
        ],
      ]) as Invocation[];
      const counts: Record<string, KeywordCounts> = {};
      for (const keyword of keywords) counts[keyword] = { total: 0, unread: 0 };
      try {
        /*
         * Sliced to the server's batch ceiling (`maxCallsInRequest`, advertised
         * as 16 and honoured by `call`/`flush`): two queries per keyword means a
         * reader with nine labels sends eighteen calls, and a real server refuses
         * the whole request, with nothing landing here. The low-level `request`
         * does not chunk on its own, so the bound is applied here.
         */
        const max = client.maxCallsInRequest;
        for (let at = 0; at < calls.length; at += max) {
          const res = await client.request(calls.slice(at, at + max));
          for (const [, result, id] of res.methodResponses) {
            const which = String(id).slice(0, 1);
            const keyword = keywords[Number(String(id).slice(1))];
            if (!keyword) continue;
            const total = (result as { total?: number }).total ?? 0;
            if (which === "t") counts[keyword]!.total = total;
            else counts[keyword]!.unread = total;
          }
        }
        set({ labelCounts: counts });
      } catch {
        // A count is decoration. Failing to get one is not worth a toast, and
        // the sidebar falls back to drawing the label without a number.
      }
    },
  };
}
