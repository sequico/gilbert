import { useMemo } from "react";
import { t } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { type DialerSource, dialerSources } from "@/lib/phone/dialer";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";

/**
 * The phone's contact sources, read once and shared by both panes.
 *
 * The contacts pane lists them and the call history resolves a number back to a
 * person against them, so the two cannot disagree about who "+44 …" is: a card
 * dialled and a card shown are always the same set — the reader's own books,
 * the installation's directory, and each group's.
 */
export function usePhoneSources(): {
  sources: DialerSource[];
  groups: Array<{ id: string; accountId: string; label: string }>;
} {
  const cards = useContacts((s) => s.cards);
  const sharedBooks = useContacts((s) => s.sharedBooks);
  const cardsIn = useContacts((s) => s.cardsIn);
  const ownAccountId = useContacts((s) => s.accountId) ?? "own";
  const mailAccounts = useMail((s) => s.mailAccounts);

  const groups = useMemo(
    () =>
      groupMailboxAccounts(mailAccounts).map((g) => ({
        id: `group:${g.accountId}`,
        accountId: g.accountId,
        label: g.name,
      })),
    [mailAccounts],
  );
  const ownCards = useMemo(() => Object.values(cards), [cards]);
  const sources: DialerSource[] = useMemo(
    () =>
      dialerSources({
        ownCards,
        sharedBooks,
        cardsIn,
        groups: groups.map((g) => ({ accountId: g.accountId, name: g.label })),
        personalLabel: t("Personal"),
        ownAccountId,
      }),
    [ownCards, sharedBooks, cardsIn, groups, ownAccountId],
  );
  return { sources, groups };
}
