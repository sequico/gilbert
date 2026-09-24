import { PhoneIncoming, PhoneMissed, PhoneOutgoing } from "lucide-react";
import { useMemo } from "react";
import { formatDateTime } from "@/lib/datetime";
import { t } from "@/lib/i18n";
import { allDialerCards, contactMatchFor } from "@/lib/phone/dialer";
import { usePhone } from "@/store/phone";
import { usePhoneSources } from "./usePhoneSources";

/**
 * The account's calls, the pane beside the dialer (ADR 0023).
 *
 * The list is the account's own `calls.json`, newest first, so it follows the
 * person between devices. Each row is one call: which way it went, the contact
 * it matches with the number underneath, when, and — for a call that connected
 * — how many seconds it lasted.
 */

/** The word a call shows where a connected one shows its seconds. */
const OUTCOME_LABELS: Record<string, string> = {
  missed: "Missed",
  declined: "Declined",
  failed: "Failed",
};

export function CallLogPanel() {
  const callLog = usePhone((s) => s.callLog);
  // The same sources the contacts pane lists, so a number dialled from there
  // resolves back to the same person here.
  const { sources } = usePhoneSources();
  const allCards = useMemo(() => allDialerCards(sources), [sources]);

  return (
    <div className="phone-pane phone-log-panel">
      <div className="nav-section" style={{ padding: "0 0 6px" }}>
        <span>{t("Recent calls")}</span>
      </div>
      <div className="phone-log-list">
        {callLog.map((entry, i) => {
          const match = contactMatchFor(allCards, entry.remote);
          // The name when there is one, the number otherwise; the number and
          // its type (mobile, work) under it.
          const title = match?.name ?? entry.remote;
          const label = match?.label ? match.label.toUpperCase() : "";
          const bad = entry.outcome !== "answered";
          const Icon =
            entry.direction === "out" ? PhoneOutgoing : bad ? PhoneMissed : PhoneIncoming;
          return (
            <div key={`${entry.at}:${i}`} className={`phone-log-row ${bad ? "bad" : ""}`}>
              <Icon size={15} className="phone-log-icon" />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="truncate">{title}</div>
                {match && (
                  <div className="hint truncate">
                    {entry.remote}
                    {label && <span className="phone-log-label"> {label}</span>}
                  </div>
                )}
              </div>
              <div className="phone-log-right">
                <span className="phone-log-time hint">
                  {formatDateTime(new Date(entry.at))}
                </span>
                <span className="phone-log-secs">
                  {entry.outcome === "answered"
                    ? t("{n}s", { n: entry.seconds })
                    : t(OUTCOME_LABELS[entry.outcome] ?? "Failed")}
                </span>
              </div>
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
