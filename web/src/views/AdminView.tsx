import { Bot, Info, KeyRound, ShieldCheck, Tag, Users } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { type SectionGroup, type SectionItem, SectionShell } from "@/ui/SectionShell";
import { AdminAgents } from "@/views/admin/AdminAgents";
import { AdminPolicy } from "@/views/admin/AdminPolicy";
import { AdminUsers } from "@/views/admin/AdminUsers";
import { GroupLabels } from "@/views/admin/GroupLabels";
import { GroupWorkers } from "@/views/admin/GroupWorkers";
import { AboutSettings } from "@/views/settings/AboutSettings";

type AdminOwner = "mailer" | "assistant" | "stalwart" | null;
type AdminSection = SectionItem & { el: ReactNode; owner: AdminOwner };

/**
 * The two Gilbert-owned groups, and what each one is for.
 *
 * "Mailer" is the mail server's own administration — policy, the group label
 * catalogs, forced password changes — the surfaces ADR 0004/0005/0006 added
 * before there was an agent at all. "Assistant" is everything ADR 0003/0009
 * added: the fleet's own identity and per-tier models, and what it does inside
 * each group. Splitting them is the fix for the section that used to hold
 * both kinds of thing under one unlabelled "Gilbert" heading.
 */
const SECTIONS: AdminSection[] = [
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
    label: "Agents",
    icon: <Bot size={18} />,
    el: <AdminAgents />,
    owner: "assistant",
  },
  {
    id: "group-workers",
    label: t("Group workers"),
    icon: <Users size={18} />,
    el: <GroupWorkers />,
    owner: "assistant",
  },
  {
    id: "about",
    label: "About",
    icon: <Info size={18} />,
    el: <AboutSettings />,
    owner: null,
  },
];

/**
 * The administration surface, shown when the signed-in user is a Stalwart
 * admin (ADR 0007). It shares the settings layout — `SectionShell` is the one
 * copy both surfaces render through — so the shield icon in the top bar and
 * these sections stay consistent. The nav groups the surfaces by owner:
 * "Gilbert Mailer" for the mail server's own administration (policy, forced
 * passwords, group label catalogs), "Gilbert Assistant" for the agent fleet
 * (ADR 0003/0009) and what it does per group, server configuration (the
 * future Sieve editor and its peers) under "Stalwart" — which starts empty —
 * and About ungrouped at the tail.
 */
export function AdminView({ section }: { section?: string }) {
  const current = SECTIONS.find((s) => s.id === section);
  const byOwner = (owner: AdminSection["owner"]) =>
    SECTIONS.filter((s) => s.owner === owner).map((s) => ({
      id: s.id,
      label: s.label,
      icon: s.icon,
    }));
  const groups: SectionGroup[] = [
    { label: t("Gilbert Mailer"), items: byOwner("mailer") },
    { label: t("Gilbert Assistant"), items: byOwner("assistant") },
    {
      label: "Stalwart",
      emptyLabel: t(
        "Stalwart server configuration (Sieve editor and more) will appear here.",
      ),
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
