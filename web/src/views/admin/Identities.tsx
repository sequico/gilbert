/**
 * Identities (ADR 0007): the surfaces an administrator sets a principal's
 * identity through — a person's under User identities, a group's under Group
 * identities.
 *
 * Both identity tabs stay mounted, the one not shown carrying `hidden`, so a
 * tab keeps what it was in the middle of and switching back does not read it
 * again.
 */

import { type ReactNode, useState } from "react";
import { t } from "@/lib/i18n";
import { GroupIdentities } from "@/views/admin/GroupIdentities";
import { UserIdentities } from "@/views/admin/UserIdentities";

/** The tab order, for the keyboard movement between them, and the one shown first. */
const DEFAULT_TAB = "user";
const TAB_IDS = [DEFAULT_TAB, "group"];

/** The tab one arrow press moves to, wrapping at the ends. */
function neighbour(from: string, delta: number): string {
  const index = TAB_IDS.indexOf(from);
  const next = (index + delta + TAB_IDS.length) % TAB_IDS.length;
  return TAB_IDS[next] ?? from;
}

export function Identities() {
  const [tab, setTab] = useState(DEFAULT_TAB);
  const list: Array<{ id: string; label: string; el: ReactNode }> = [
    { id: "user", label: t("User identities"), el: <UserIdentities /> },
    { id: "group", label: t("Group identities"), el: <GroupIdentities /> },
  ];

  const select = (id: string) => {
    setTab(id);
    document.getElementById(`identities-${id}`)?.focus();
  };

  return (
    <div>
      <div className="tabs" role="tablist" aria-label={t("Identities")}>
        {list.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="tab"
            role="tab"
            id={`identities-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`identities-${entry.id}-panel`}
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
