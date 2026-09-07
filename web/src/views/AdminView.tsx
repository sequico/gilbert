import { Info, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { type SectionItem, SectionShell } from "@/ui/SectionShell";
import { AdminPolicy } from "@/views/admin/AdminPolicy";
import { AboutSettings } from "@/views/settings/AboutSettings";

const SECTIONS: Array<SectionItem & { el: ReactNode }> = [
  {
    id: "policy",
    label: t("Policy"),
    icon: <ShieldCheck size={18} />,
    el: <AdminPolicy />,
  },
  { id: "about", label: "About", icon: <Info size={18} />, el: <AboutSettings /> },
];

/**
 * The administration surface, for members of the `gilbert-admin` group on any
 * domain of the server (ADR 0001). It shares the settings layout —
 * `SectionShell` is the one copy both surfaces render through — so the shield
 * icon in the top bar and these sections stay consistent. v1 is the
 * installation-wide policy editor (ADR 0001 §4, ADR 0004); the per-user
 * surface follows as the next layer on the same document shape.
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
