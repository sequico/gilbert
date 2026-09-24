import { PhoneIncoming, PhoneMissed, PhoneOutgoing } from "lucide-react";
import { useMemo } from "react";
import { formatDateTime } from "@/lib/datetime";
import { t } from "@/lib/i18n";
import { contactNameFor } from "@/lib/phone/dialer";
import { useContacts } from "@/store/contacts";
import { usePhone } from "@/store/phone";

/**
 * The account's calls, the panel beside the dialer (ADR 0023).
 *
 * The list is the account's own `calls.json`, newest first, so it follows the
 * person between devices. Each row is one call: which way it went, the number
 * or the contact it matches, when, and — for a call that connected — how many
 * seconds it lasted.
 */

/** The word a call shows where a connected one shows its seconds. */
const OUTCOME_LABELS: Record<string, string> = {
  missed: "Missed",
  declined: "Declined",
  failed: "Failed",
};

export function CallLogPanel() {
  const callLog = usePhone((s) => s.callLog);
  const cards = useContacts((s) => s.cards);
  const allCards = useMemo(() => Object.values(cards), [cards]);

  return (
    <div className="phone-log-panel">
      <div className="phone-col-title">{t("Recent calls")}</div>
      <div className="phone-log-list">
        {callLog.map((entry, i) => {
          const name = contactNameFor(allCards, entry.remote);
          const bad = entry.outcome !== "answered";
          const Icon =
            entry.direction === "out" ? PhoneOutgoing : bad ? PhoneMissed : PhoneIncoming;
          return (
            <div key={`${entry.at}:${i}`} className={`phone-log-row ${bad ? "bad" : ""}`}>
              <Icon size={15} className="phone-log-icon" />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="truncate">{name ?? entry.remote}</div>
                <div className="hint truncate">{formatDateTime(new Date(entry.at))}</div>
              </div>
              <span className="phone-log-secs">
                {entry.outcome === "answered"
                  ? t("{n}s", { n: entry.seconds })
                  : t(OUTCOME_LABELS[entry.outcome] ?? "Failed")}
              </span>
            </div>
          );
        })}
        {!callLog.length && (
          <p className="hint" style={{ padding: "4px 6px" }}>
            {t("No calls yet.")}
          </p>
        )}
      </div>
    </div>
  );
}
