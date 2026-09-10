import { Bot, Info, ShieldCheck, Tag, Users } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { type SectionGroup, type SectionItem, SectionShell } from "@/ui/SectionShell";
import { AdminAgents } from "@/views/admin/AdminAgents";
import { AdminPolicy } from "@/views/admin/AdminPolicy";
import { AdminUsers } from "@/views/admin/AdminUsers";
import { GroupLabels } from "@/views/admin/GroupLabels";
import { GroupWorkers } from "@/views/admin/GroupWorkers";
import { AboutSettings } from "@/views/settings/AboutSettings";

type AdminSection = SectionItem & { el: ReactNode; owner: "gilbert" | "stalwart" | null };

const SECTIONS: AdminSection[] = [
  {
    id: "policy",
    label: "Policy",
    icon: <ShieldCheck size={18} />,
    el: <AdminPolicy />,
    owner: "gilbert",
  },
  {
    id: "users",
    label: t("Force passwords"),
    icon: <Users size={18} />,
    el: <AdminUsers />,
    owner: "gilbert",
  },
  {
    id: "group-labels",
    label: t("Group labels"),
    icon: <Tag size={18} />,
    el: <GroupLabels />,
    owner: "gilbert",
  },
  {
    id: "agents",
    label: "Agents",
    icon: <Bot size={18} />,
    el: <AdminAgents />,
    owner: "gilbert",
  },
  {
    id: "group-workers",
    label: t("Group workers"),
    icon: <Users size={18} />,
    el: <GroupWorkers />,
    owner: "gilbert",
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
 * Gilbert's own administration (policy, forced passwords, group label
 * catalogs, the agent fleet) under “Gilbert”, server configuration (the future
 * Sieve editor and its peers) under “Stalwart” — which starts empty — and
 * About ungrouped at the tail.
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
    { label: "Gilbert", items: byOwner("gilbert") },
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
