import { ChevronRight, ListFilter, Phone, PhoneOff, Plus, Users } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { t } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { useMail } from "@/store/mail";
import { activeGroupName, useOutbound } from "@/store/outbound";

/**
 * Outbound's tree (ADR 0040): the calls to work, the campaigns that hold them,
 * and the one list that lives on its own.
 *
 * Today comes first because it is where the work happens; the campaigns below it
 * are what narrows it, the ones being worked first and the closed ones behind a
 * fold; and the do-not-call list is the group's own promise, not a campaign's.
 */
export function TodaySidebar() {
  const groups = groupMailboxAccounts(useMail((s) => s.mailAccounts));
  const { group, campaign, campaigns, selectGroup, filterCampaign, load } = useOutbound();
  const [location] = useLocation();
  const [archived, setArchived] = useState(false);
  const active = activeGroupName(groups, group);

  useEffect(() => {
    if (active) void load(active).catch(() => {});
  }, [active, load]);

  const running = campaigns.filter((entry) => entry.state === "running");
  const closed = campaigns.filter((entry) => entry.state === "closed");
  const at = (path: string) => location === path;

  const entry = (path: string, label: string, icon: ReactNode) => (
    <Link
      href={path}
      className={`nav-item ${at(path) ? "active" : ""}`}
      aria-current={at(path) ? "page" : undefined}
    >
      {icon}
      <span className="nav-label">{label}</span>
    </Link>
  );

  return (
    <>
      {groups.length > 1 && (
        <div className="field" style={{ padding: "8px 12px 4px" }}>
          <label htmlFor="today-sidebar-group">{t("Group")}</label>
          <select
            id="today-sidebar-group"
            className="select"
            value={active}
            onChange={(e) => selectGroup(e.target.value)}
          >
            {groups.map((option) => (
              <option key={option.accountId} value={option.name}>
                {option.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {entry("/today", t("Today"), <Phone size={16} aria-hidden="true" />)}

      <div className="nav-section">{t("Campaigns")}</div>
      <button
        type="button"
        className={`nav-item ${campaign === "" ? "active" : ""}`}
        aria-pressed={campaign === ""}
        onClick={() => filterCampaign("")}
      >
        <ListFilter size={16} aria-hidden="true" />
        <span className="nav-label">{t("All campaigns")}</span>
      </button>
      {running.map((option) => (
        <button
          type="button"
          key={option.uid}
          className={`nav-item ${campaign === option.uid ? "active" : ""}`}
          aria-pressed={campaign === option.uid}
          title={option.purpose}
          onClick={() => filterCampaign(option.uid)}
        >
          <Users size={16} aria-hidden="true" />
          <span className="nav-label truncate">{option.purpose}</span>
        </button>
      ))}
      {closed.length > 0 && (
        <>
          <button
            type="button"
            className={`nav-item ${archived ? "open" : ""}`}
            aria-expanded={archived}
            onClick={() => setArchived((open) => !open)}
          >
            <ChevronRight
              size={16}
              aria-hidden="true"
              style={{
                transform: archived ? "rotate(90deg)" : undefined,
                transition: "transform .15s",
              }}
            />
            <span className="nav-label">{t("Archived")}</span>
            <span className="nav-count">{closed.length}</span>
          </button>
          {archived &&
            closed.map((option) => (
              // A closed list takes no work, so it is named rather than offered:
              // what survives it is its cards, its calls and its handoff.
              <div
                key={option.uid}
                className="nav-item archived-item"
                title={option.purpose}
              >
                <span className="nav-label truncate">{option.purpose}</span>
              </div>
            ))}
        </>
      )}
      {entry("/today/new", t("Start a campaign"), <Plus size={16} aria-hidden="true" />)}

      <div className="nav-section">{t("Your list")}</div>
      {entry(
        "/today/do-not-call",
        t("Do not call"),
        <PhoneOff size={16} aria-hidden="true" />,
      )}
    </>
  );
}
