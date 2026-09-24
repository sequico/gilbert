/**
 * Identities and SIP Phone (ADR 0007, ADR 0023): the two surfaces an
 * administrator sets a principal's identity through, as two tabs of one
 * administration section — a person's under User identities, a group's under
 * Group identities — beside the line that says what the phone's bridge needs.
 *
 * Both tabs stay mounted, the one not shown carrying `hidden`, so a tab keeps
 * what it was in the middle of and switching back does not read it again.
 */

import { BRIDGE_MEDIA_PORTS } from "@gilbert/shared/phone";
import { useState } from "react";
import { t } from "@/lib/i18n";
import { GroupIdentities } from "@/views/admin/GroupIdentities";
import { UserIdentities } from "@/views/admin/UserIdentities";

/** The tabs, in the order the section offers them. */
const TABS = [
  { id: "user", label: "User identities", el: <UserIdentities /> },
  { id: "group", label: "Group identities", el: <GroupIdentities /> },
];

export function IdentitiesAndSipPhone() {
  const [tab, setTab] = useState(TABS[0]?.id ?? "user");
  return (
    <div>
      {/*
       * The one thing whoever installs Gilbert must open for the phone: the
       * bridge's media range. It is the deployment's fact, stated here rather
       * than configured anywhere (ADR 0023).
       */}
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "The phone's Janus bridge needs its media UDP range ({ports}) open inbound. The SIP leg to the provider is outbound, so no SIP port is opened.",
          { ports: BRIDGE_MEDIA_PORTS },
        )}
      </p>
      <div className="tabs" role="tablist" aria-label={t("Identities and SIP Phone")}>
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="tab"
            role="tab"
            id={`identities-sip-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`identities-sip-${entry.id}-panel`}
            onClick={() => setTab(entry.id)}
          >
            {t(entry.label)}
          </button>
        ))}
      </div>
      {TABS.map((entry) => (
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
