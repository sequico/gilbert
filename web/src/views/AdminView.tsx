import { Info, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { type SectionItem, SectionShell } from "@/ui/SectionShell";
import { AdminDefaults } from "@/views/admin/AdminDefaults";
import { AboutSettings } from "@/views/settings/AboutSettings";

const SECTIONS: Array<SectionItem & { el: ReactNode }> = [
  { id: "about", label: "About", icon: <Info size={18} />, el: <AboutSettings /> },
  {
    id: "defaults",
    label: "Gilbert Defaults",
    icon: <ShieldCheck size={18} />,
    el: <AdminDefaults />,
  },
];

/**
 * The administration surface, for members of the `gilbert-admin@…` group
 * (ADR 0001). It shares the settings layout — `SectionShell` is the one copy
 * both surfaces render through — so the shield icon in the top bar and these
 * sections stay consistent. The surface itself is being built on ADR 0001
 * (per-user policy) and ADR 0004 (rule changes reach clients by re-login).
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
      {current ? current.el : <AboutSettings />}
    </SectionShell>
  );
}
