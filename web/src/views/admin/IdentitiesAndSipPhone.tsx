/**
 * Identities and SIP Phone (ADR 0007, ADR 0023): the surfaces an administrator
 * sets a principal's identity through — a person's under User identities, a
 * group's under Group identities — beside the phone's bridge under Bridge
 * status, which reports what it is doing and what is out of place.
 *
 * Both identity tabs stay mounted, the one not shown carrying `hidden`, so a
 * tab keeps what it was in the middle of and switching back does not read it
 * again.
 */

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { fetchPhoneStatus, type PhoneStatus } from "@/lib/phoneAdmin";
import { GroupIdentities } from "@/views/admin/GroupIdentities";
import { PhoneStatusPanel } from "@/views/admin/PhoneStatusPanel";
import { UserIdentities } from "@/views/admin/UserIdentities";

/** The tab order, for the keyboard movement between them, and the one shown first. */
const DEFAULT_TAB = "user";
const TAB_IDS = [DEFAULT_TAB, "group", "status"];

/**
 * The tabs, built at render so their labels are translated then rather than at
 * import — a language picked later still reaches them. The active tab is passed
 * through so a panel can act on being opened (the bridge status checks itself).
 */
function tabs(
  active: string,
  status: PhoneStatus | null,
  refreshStatus: () => Promise<void>,
): Array<{ id: string; label: string; el: ReactNode }> {
  return [
    { id: "user", label: t("User identities"), el: <UserIdentities /> },
    { id: "group", label: t("Group identities"), el: <GroupIdentities /> },
    {
      id: "status",
      label: t("Bridge status"),
      el: (
        <PhoneStatusPanel
          active={active === "status"}
          status={status}
          refreshStatus={refreshStatus}
        />
      ),
    },
  ];
}

/** The tab one arrow press moves to, wrapping at the ends. */
function neighbour(from: string, delta: number): string {
  const index = TAB_IDS.indexOf(from);
  const next = (index + delta + TAB_IDS.length) % TAB_IDS.length;
  return TAB_IDS[next] ?? from;
}

export function IdentitiesAndSipPhone() {
  const [tab, setTab] = useState(DEFAULT_TAB);
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  /*
   * One read of the bridge's state for the whole surface (SSOT): the banner
   * above the tabs and the Bridge status rows are the same fact, so the panel
   * is handed this and never reads it itself. Re-check feeds the same function
   * back, so a refresh is the one door either way.
   */
  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await fetchPhoneStatus());
    } catch {
      // A status that cannot be read is not a verdict, so nothing is claimed.
      setStatus(null);
    }
  }, []);
  const list = tabs(tab, status, refreshStatus);

  // Read once when the surface opens, whatever tab is active: the banner needs
  // the bridge's state before the Bridge status tab is ever visited.
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const select = (id: string) => {
    setTab(id);
    document.getElementById(`identities-sip-${id}`)?.focus();
  };

  return (
    <div>
      {status && !status.available && (
        <div className="warn-box" style={{ marginBottom: 12 }}>
          {t(
            "The phone is not available on this deployment: {reason}. Open Bridge status for what to fix.",
            { reason: status.reason ?? "" },
          )}
        </div>
      )}
      <div className="tabs" role="tablist" aria-label={t("Identities and SIP Phone")}>
        {list.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="tab"
            role="tab"
            id={`identities-sip-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`identities-sip-${entry.id}-panel`}
            tabIndex={tab === entry.id ? 0 : -1}
            onClick={() => select(entry.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                select(neighbour(entry.id, 1));
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                select(neighbour(entry.id, -1));
              }
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {list.map((entry) => (
        <div
          key={entry.id}
          id={`identities-sip-${entry.id}-panel`}
          role="tabpanel"
          aria-labelledby={`identities-sip-${entry.id}`}
          hidden={tab !== entry.id}
        >
          {entry.el}
        </div>
      ))}
    </div>
  );
}
