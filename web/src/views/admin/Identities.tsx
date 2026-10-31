/**
 * Identities (ADR 0005): the surfaces an administrator sets a principal's
 * identity through — a person's under User identities, a group's under Group
 * identities.
 *
 * Both identity tabs stay mounted, the one not shown carrying `hidden`, so a
 * tab keeps what it was in the middle of and switching back does not read it
 * again.
 */

import { useState } from "react";
import { t } from "@/lib/i18n";
import { TabStrip } from "@/ui/tabs";
import { GroupIdentities } from "@/views/admin/GroupIdentities";
import { UserIdentities } from "@/views/admin/UserIdentities";

/** The one shown first. */
const DEFAULT_TAB = "user";

export function Identities() {
  const [tab, setTab] = useState(DEFAULT_TAB);
  const list = [
    { id: "user", label: t("User identities"), el: <UserIdentities /> },
    { id: "group", label: t("Group identities"), el: <GroupIdentities /> },
  ];

  return (
    <div>
      <TabStrip
        label={t("Identities")}
        tabs={list.map((entry) => ({ id: entry.id, content: entry.label }))}
        selected={tab}
        onSelect={setTab}
        idPrefix="identities"
      />
      {list.map((entry) => (
        <div
          key={entry.id}
          id={`identities-${entry.id}-panel`}
          role="tabpanel"
          aria-labelledby={`identities-${entry.id}`}
          hidden={tab !== entry.id}
        >
          {entry.el}
        </div>
      ))}
    </div>
  );
}
