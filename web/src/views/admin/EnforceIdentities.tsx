/**
 * Enforce Identities (ADR 0010): the two surfaces an administrator sets a
 * principal's identity through, as two tabs of one administration section —
 * a person's under User identities, a group's under Group identities.
 *
 * Both tabs stay mounted, the one not shown carrying `hidden`, so a tab keeps
 * what it was in the middle of and switching back does not read it again.
 */

import { useState } from "react";
import { t } from "@/lib/i18n";
import { GroupIdentities } from "@/views/admin/GroupIdentities";
import { UserIdentities } from "@/views/admin/UserIdentities";

/** The tabs, in the order the section offers them. */
const TABS = [
  { id: "user", label: "User identities", el: <UserIdentities /> },
  { id: "group", label: "Group identities", el: <GroupIdentities /> },
];

export function EnforceIdentities() {
  const [tab, setTab] = useState(TABS[0]?.id ?? "user");
  return (
    <div>
      <div className="tabs" role="tablist" aria-label={t("Enforce Identities")}>
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="tab"
            role="tab"
            id={`enforce-identities-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`enforce-identities-${entry.id}-panel`}
            onClick={() => setTab(entry.id)}
          >
            {t(entry.label)}
          </button>
        ))}
      </div>
      {TABS.map((entry) => (
        <div
          key={entry.id}
          id={`enforce-identities-${entry.id}-panel`}
          role="tabpanel"
          aria-labelledby={`enforce-identities-${entry.id}`}
          hidden={tab !== entry.id}
        >
          {entry.el}
        </div>
      ))}
    </div>
  );
}
