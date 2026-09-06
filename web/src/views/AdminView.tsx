import { Info, ShieldCheck } from "lucide-react";
import { t } from "@/lib/i18n";
import { SectionShell } from "@/ui/SectionShell";
import { AdminDefaults } from "@/views/admin/AdminDefaults";
import { AboutSettings } from "@/views/settings/AboutSettings";

const SECTIONS = [
  { id: "about", label: "About", icon: <Info size={18} /> },
  { id: "defaults", label: "Gilbert Defaults", icon: <ShieldCheck size={18} /> },
];

/**
 * The administration surface, for members of the `gilbert-admin@…` group
 * (ADR 0001). It shares the settings layout — `SectionShell` is the one copy
 * both surfaces render through — so the shield icon in the top bar and these
 * sections stay consistent. The surface itself is being built on ADR 0001
 * (per-user policy) and ADR 0004 (rule changes reach clients by re-login).
 */
export function AdminView({ section }: { section?: string }) {
  const active = SECTIONS.find((s) => s.id === section)?.id ?? "about";
  return (
    <SectionShell
      heading={t("Administration")}
      items={SECTIONS}
      activeId={active}
      base="/admin"
    >
      {active === "about" ? <AboutSettings /> : <AdminDefaults />}
    </SectionShell>
  );
}
