import { useEffect } from "react";
import { isGroupMailboxAccount } from "@/lib/mailAccounts";
import { useGroupLabels } from "@/store/groupLabels";
import { useMail } from "@/store/mail";
import type { Label } from "@/store/settings";
import { useSettings } from "@/store/settings";

/**
 * Whether the account on screen is a group mailbox rather than the reader's
 * own: the one classifier, the mail store's probe (`isGroupMailboxAccount`),
 * which is the same answer the catalog's own read and the label counts take.
 */
export function useIsGroupMailbox(): boolean {
  const accountId = useMail((s) => s.accountId);
  const accounts = useMail((s) => s.mailAccounts);
  return isGroupMailboxAccount(accountId, accounts);
}

/**
 * The labels the current mail view must render: the group's own catalog when
 * looking at a group mailbox, otherwise the reader's personal labels. Loading
 * the group catalog is triggered here (idempotent) the first time it is asked.
 */
export function useEffectiveLabels(): Label[] {
  const accountId = useMail((s) => s.accountId);
  const accounts = useMail((s) => s.mailAccounts);
  const personal = useSettings((s) => s.settings.labels);
  const byAccount = useGroupLabels((s) => s.byAccount);
  const isGroup = isGroupMailboxAccount(accountId, accounts);

  useEffect(() => {
    if (isGroup && accountId) void useGroupLabels.getState().load(accountId);
  }, [isGroup, accountId]);

  if (!isGroup || !accountId) return personal;
  return byAccount[accountId] ?? [];
}
