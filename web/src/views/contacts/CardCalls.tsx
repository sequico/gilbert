import { useEffect, useState } from "react";
import { formatDateTime } from "@/lib/datetime";
import { plural, t } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { type CardCall, fetchCardCalls } from "@/lib/outbound";
import { useMail } from "@/store/mail";

/**
 * What was said to this card, in the group that called it (ADR 0040).
 *
 * A card outlives the campaigns that touched it, so the history lives with the
 * card and not with a list: a caller opening it in November reads what a colleague
 * said in October. It is drawn only for a group's card, because a personal contact
 * holds no group's calls, and an empty history draws nothing at all — a card nobody
 * has called is not a card with a problem.
 */
export function CardCalls({
  cardUid,
  accountId,
}: {
  cardUid: string;
  /** The account holding the card: its own, or a group's. */
  accountId: string | null;
}) {
  const groups = groupMailboxAccounts(useMail((s) => s.mailAccounts));
  const group = groups.find((entry) => entry.accountId === accountId)?.name ?? "";
  const [calls, setCalls] = useState<CardCall[]>([]);
  const [trimmed, setTrimmed] = useState(0);

  useEffect(() => {
    if (!group || !cardUid) return;
    let live = true;
    fetchCardCalls(group, cardUid)
      .then((answer) => {
        if (!live) return;
        setCalls(answer.calls);
        setTrimmed(answer.trimmed);
      })
      // A history that cannot be read is not worth a sentence on somebody's
      // contact card: the rest of the card is still theirs to read.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [group, cardUid]);

  if (!group || calls.length === 0) return null;

  return (
    <div className="contact-section">
      <h3>{t("Calls")}</h3>
      {calls.map((call, index) => (
        <div key={`${call.at}-${index}`} className="contact-kv">
          <span className="k">{formatDateTime(new Date(call.at))}</span>
          <span className="v">
            {call.by} · {call.outcome}
            {call.note && ` — ${call.note}`}
          </span>
        </div>
      ))}
      {trimmed > 0 && (
        <p className="hint">
          {plural(trimmed, {
            one: "{n} older call is no longer kept here",
            other: "{n} older calls are no longer kept here",
          })}
        </p>
      )}
    </div>
  );
}
