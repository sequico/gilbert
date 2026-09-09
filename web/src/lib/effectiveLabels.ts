import { useEffect } from "react";
import { isGroupMailbox } from "@/lib/mailAccounts";
import { useGroupLabels } from "@/store/groupLabels";
import { useMail } from "@/store/mail";
import type { Label } from "@/store/settings";
import { useSettings } from "@/store/settings";

/** Whether the account on screen is a group mailbox rather than the reader's own. */
export function useIsGroupMailbox(): boolean {
  const accountId = useMail((s) => s.accountId);
  const ownAccountId = useMail((s) => s.ownAccountId);
  return isGroupMailbox(accountId, ownAccountId);
}

/**
 * The labels the current mail view must render: the group's own catalog when
 * looking at a group mailbox, otherwise the reader's personal labels. Loading
 * the group catalog is triggered here (idempotent) the first time it is asked.
 */
export function useEffectiveLabels(): Label[] {
  const accountId = useMail((s) => s.accountId);
  const ownAccountId = useMail((s) => s.ownAccountId);
  const personal = useSettings((s) => s.settings.labels);
  const byAccount = useGroupLabels((s) => s.byAccount);
  const isGroup = isGroupMailbox(accountId, ownAccountId);

  useEffect(() => {
    if (isGroup && accountId) void useGroupLabels.getState().load(accountId);
  }, [isGroup, accountId]);

  if (!isGroup || !accountId) return personal;
  return byAccount[accountId] ?? [];
}
