import {
  Bell,
  Bot,
  Info,
  KeyRound,
  ShieldCheck,
  Tag,
  UserCog,
  Users,
} from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { t } from "@/lib/i18n";
import { useAgents } from "@/store/agents";
import { type SectionGroup, type SectionItem, SectionShell } from "@/ui/SectionShell";
import { AdminAgents } from "@/views/admin/AdminAgents";
import { AdminApprovals } from "@/views/admin/AdminApprovals";
import { AdminPolicy } from "@/views/admin/AdminPolicy";
import { AdminUsers } from "@/views/admin/AdminUsers";
import { EnforceIdentities } from "@/views/admin/EnforceIdentities";
import { GroupAgents } from "@/views/admin/GroupAgents";
import { GroupLabels } from "@/views/admin/GroupLabels";
import { AboutSettings } from "@/views/settings/AboutSettings";

type AdminOwner = "mailer" | "assistant" | "stalwart" | null;
type AdminSection = SectionItem & { el: ReactNode; owner: AdminOwner };

/**
 * The administration's groups, and what each one is for.
 *
 * "Gilbert Mailer" is the mail server's own administration — policy, the group
 * label catalogs, forced password changes — the surfaces ADR 0004/0005 cover,
 * which stand without an agent. "Assistant" is everything ADR 0003 covers,
 * restructured by ADR 0014 into three sections: **Master** (the installation,
 * configured once), **Group Agents** (one group's automations, standing
 * instruction, memory, audit and fleet, behind a single picker) and
 * **Approvals** (cross-group oversight, read-only by construction). "Stalwart"
 * is the mail server's own records, written over JMAP or over its
 * configuration API: **Enforce Identities**, one section holding a person's and
 * a group's behind two tabs (ADR 0007), and, in time, its system Sieve scripts
 * (ADR 0008). The split keeps each kind of thing under a heading that names it,
 * rather than both under one unlabelled "Gilbert".
 */
function sections(pendingApprovals: number): AdminSection[] {
  return [
    {
      id: "policy",
      label: "Policy",
      icon: <ShieldCheck size={18} />,
      el: <AdminPolicy />,
      owner: "mailer",
    },
    {
      id: "group-labels",
      label: t("Group labels"),
      icon: <Tag size={18} />,
      el: <GroupLabels />,
      owner: "mailer",
    },
    {
      id: "users",
      label: t("Force passwords"),
      icon: <KeyRound size={18} />,
      el: <AdminUsers />,
      owner: "mailer",
    },
    {
      id: "agents",
      label: "Master",
      icon: <Bot size={18} />,
      el: <AdminAgents />,
      owner: "assistant",
    },
    {
      id: "group-agents",
      label: t("Group Agents"),
      icon: <Users size={18} />,
      el: <GroupAgents />,
      owner: "assistant",
    },
    {
      id: "approvals",
      label: t("Approvals"),
      icon: (
        <span style={{ position: "relative", display: "inline-flex" }}>
          <Bell size={18} />
          {pendingApprovals > 0 && (
            <span
              className="badge"
              style={{
                position: "absolute",
                top: -6,
                right: -8,
                minWidth: 15,
                height: 15,
              }}
            >
              {pendingApprovals}
            </span>
          )}
        </span>
      ),
      el: <AdminApprovals />,
      owner: "assistant",
    },
    {
      id: "enforce-identities",
      label: t("Enforce Identities"),
      icon: <UserCog size={18} />,
      el: <EnforceIdentities />,
      owner: "stalwart",
    },
    {
      id: "about",
      label: "About",
      icon: <Info size={18} />,
      el: <AboutSettings />,
      owner: null,
    },
  ];
}

/**
 * The administration surface, shown when the signed-in user is a Stalwart
 * admin (ADR 0001). It shares the settings layout — `SectionShell` is the one
 * copy both surfaces render through — so the shield icon in the top bar and
 * these sections stay consistent. The nav groups the surfaces by owner:
 * "Gilbert Mailer" for the mail server's own administration (policy, forced
 * passwords, group label catalogs), "Gilbert Assistant" for the agent fleet
 * (ADR 0003, ADR 0014) — Master, Group Agents and Approvals — and "Stalwart"
 * for the mail server's own records — the identities an administrator sets, as
 * one section with a tab per kind of principal (ADR 0007), and, in time, its
 * system Sieve scripts (ADR 0008) — with About ungrouped at the tail.
 */
export function AdminView({ section }: { section?: string }) {
  const loadStatus = useAgents((s) => s.loadStatus);
  const loadApprovals = useAgents((s) => s.loadApprovals);
  const pendingApprovals = useAgents((s) => s.approvals.length);

  // Read once whenever the administration is open, whatever section is
  // active: the Approvals badge above needs the count before that section is
  // ever visited, and the fleet status is cheap enough to read here too.
  useEffect(() => {
    void loadStatus();
    void loadApprovals();
  }, [loadStatus, loadApprovals]);

  const adminSections = sections(pendingApprovals);
  const current = adminSections.find((s) => s.id === section);
  const byOwner = (owner: AdminSection["owner"]) =>
    adminSections
      .filter((s) => s.owner === owner)
      .map((s) => ({
        id: s.id,
        label: s.label,
        icon: s.icon,
      }));
  const groups: SectionGroup[] = [
    { label: t("Gilbert Mailer"), items: byOwner("mailer") },
    { label: t("Gilbert Assistant"), items: byOwner("assistant") },
    {
      label: "Stalwart",
      emptyLabel: t("Nothing here yet."),
      items: byOwner("stalwart"),
    },
  ];
  const tail = byOwner(null);
  return (
    <SectionShell
      heading={t("Administration")}
      groups={groups}
      items={tail}
      activeId={section}
      base="/admin"
      backHref={section ? "/admin" : undefined}
      backLabel={t("Administration")}
    >
      {current ? current.el : <AdminPolicy />}
    </SectionShell>
  );
}
