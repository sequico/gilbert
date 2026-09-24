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

import { type ReactNode, useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { fetchPhoneStatus, type PhoneStatus } from "@/lib/phoneAdmin";
import { GroupIdentities } from "@/views/admin/GroupIdentities";
import { PhoneStatusPanel } from "@/views/admin/PhoneStatusPanel";
import { UserIdentities } from "@/views/admin/UserIdentities";

/** The tab order, for the keyboard movement between them. */
const TAB_IDS = ["user", "group", "status"];

/**
 * The tabs, built at render so their labels are translated then rather than at
 * import — a language picked later still reaches them. The active tab is passed
 * through so a panel can act on being opened (the bridge status checks itself).
 */
function tabs(active: string): Array<{ id: string; label: string; el: ReactNode }> {
  return [
    { id: "user", label: t("User identities"), el: <UserIdentities /> },
    { id: "group", label: t("Group identities"), el: <GroupIdentities /> },
    {
      id: "status",
      label: t("Bridge status"),
      el: <PhoneStatusPanel active={active === "status"} />,
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
  const [tab, setTab] = useState(TAB_IDS[0]);
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const list = tabs();
  const select = (id: string) => {
    setTab(id);
    document.getElementById(`identities-sip-${id}`)?.focus();
  };

  /*
   * Read whether the bridge is running, so a host that could not install it is
   * said once here and detailed in the Bridge status tab. A status that cannot
   * be read is not a verdict, so nothing is claimed.
   */
  useEffect(() => {
    let live = true;
    void fetchPhoneStatus()
      .then((next) => {
        if (live) setStatus(next);
      })
      .catch(() => {
        if (live) setStatus(null);
      });
    return () => {
      live = false;
    };
  }, []);

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
