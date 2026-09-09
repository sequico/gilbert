import { Info, ShieldCheck, Tag, Users } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { type SectionItem, SectionShell } from "@/ui/SectionShell";
import { AdminPolicy } from "@/views/admin/AdminPolicy";
import { AdminUsers } from "@/views/admin/AdminUsers";
import { GroupLabels } from "@/views/admin/GroupLabels";
import { AboutSettings } from "@/views/settings/AboutSettings";

const SECTIONS: Array<SectionItem & { el: ReactNode }> = [
  {
    id: "policy",
    label: "Policy",
    icon: <ShieldCheck size={18} />,
    el: <AdminPolicy />,
  },
  {
    id: "users",
    label: t("Force passwords"),
    icon: <Users size={18} />,
    el: <AdminUsers />,
  },
  {
    id: "group-labels",
    label: t("Group labels"),
    icon: <Tag size={18} />,
    el: <GroupLabels />,
  },
  { id: "about", label: "About", icon: <Info size={18} />, el: <AboutSettings /> },
];

/**
 * The administration surface, shown when the signed-in user is a Stalwart
 * admin (ADR 0007). It shares the settings layout — `SectionShell` is the one
 * copy both surfaces render through — so the shield icon in the top bar and
 * these sections stay consistent. v1 is the installation-wide policy editor
 * (ADR 0001 §4, ADR 0004); the per-user surface follows as the next layer on
 * the same document shape.
 */
export function AdminView({ section }: { section?: string }) {
  const current = SECTIONS.find((s) => s.id === section);
  return (
    <SectionShell
      heading={t("Administration")}
      items={SECTIONS}
      activeId={section}
      base="/admin"
      backHref={section ? "/admin" : undefined}
      backLabel={t("Administration")}
    >
      {current ? current.el : <AdminPolicy />}
    </SectionShell>
  );
}
