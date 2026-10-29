import { ListFilter, Phone, PhoneOff, Plus, Users } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { t } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { useMail } from "@/store/mail";
import { activeGroupName, useOutbound } from "@/store/outbound";

/**
 * Outbound's tree (ADR 0040): the group whose list is being worked, the campaigns
 * in it, and the three places the section has.
 *
 * The group belongs here rather than in the pane: it is a choice about *which
 * list*, and a choice drawn twice is a second way of saying the same thing. A
 * campaign narrows the queue; "Do not call" and "Start a list" act on the list as a
 * whole, so they are entries rather than buttons in the middle of the work.
 */
export function TodaySidebar() {
  const groups = groupMailboxAccounts(useMail((s) => s.mailAccounts));
  const { group, campaign, campaigns, selectGroup, filterCampaign, load } = useOutbound();
  const [location] = useLocation();
  const active = activeGroupName(groups, group);

  useEffect(() => {
    if (active) void load(active).catch(() => {});
  }, [active, load]);

  const running = campaigns.filter((entry) => entry.state === "running");
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

      <div className="nav-section">{t("Your list")}</div>
      {entry("/today", t("Queue"), <Phone size={16} aria-hidden="true" />)}
      {entry(
        "/today/do-not-call",
        t("Do not call"),
        <PhoneOff size={16} aria-hidden="true" />,
      )}
      {entry("/today/new", t("Start a list"), <Plus size={16} aria-hidden="true" />)}
    </>
  );
}
