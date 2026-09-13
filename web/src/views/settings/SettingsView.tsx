import {
  Bell,
  Calendar,
  EyeOff,
  Filter,
  Folder,
  Info,
  Keyboard,
  LayoutTemplate,
  Palette,
  PenLine,
  Plane,
  Settings as SettingsIcon,
  ShieldCheck,
  Tag,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { t } from "@/lib/i18n";
import { lazyView } from "@/lib/lazyView";
import { IDENTITIES_SECTION, visibleSettingsSections } from "@/lib/settingsSections";
import { useSession } from "@/store/session";
import { type SectionItem, SectionShell } from "@/ui/SectionShell";
import { AboutSettings } from "./AboutSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { CalendarSettings } from "./CalendarSettings";
import { FoldersSettings } from "./FoldersSettings";
import { GeneralSettings } from "./GeneralSettings";
import { IdentitiesSettings } from "./IdentitiesSettings";
import { LabelsSettings } from "./LabelsSettings";
import { NotificationsSettings } from "./NotificationsSettings";
import { PrivacySettings } from "./PrivacySettings";
import { SecuritySettings } from "./SecuritySettings";
import { ShortcutsSettings } from "./ShortcutsSettings";
import { TemplatesSettings } from "./TemplatesSettings";

const FiltersSettings = lazyView(() =>
  import("./FiltersSettings").then((m) => ({ default: m.FiltersSettings })),
);
const VacationSettings = lazyView(() =>
  import("./VacationSettings").then((m) => ({ default: m.VacationSettings })),
);

const SECTIONS: Array<SectionItem & { el: ReactNode }> = [
  {
    id: "general",
    label: "General",
    icon: <SettingsIcon size={18} />,
    el: <GeneralSettings />,
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: <Palette size={18} />,
    el: <AppearanceSettings />,
  },
  {
    id: "identities",
    label: "Identities & signatures",
    icon: <PenLine size={18} />,
    el: <IdentitiesSettings />,
  },
  {
    id: "filters",
    label: "Filters & rules",
    icon: <Filter size={18} />,
    el: <FiltersSettings />,
  },
  {
    id: "vacation",
    label: "Out of office",
    icon: <Plane size={18} />,
    el: <VacationSettings />,
  },
  {
    id: "folders",
    label: "Folders",
    icon: <Folder size={18} />,
    el: <FoldersSettings />,
  },
  { id: "labels", label: "Labels", icon: <Tag size={18} />, el: <LabelsSettings /> },
  {
    id: "templates",
    label: "Templates",
    icon: <LayoutTemplate size={18} />,
    el: <TemplatesSettings />,
  },
  {
    id: "calendar",
    label: "Calendar & contacts",
    icon: <Calendar size={18} />,
    el: <CalendarSettings />,
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: <Bell size={18} />,
    el: <NotificationsSettings />,
  },
  {
    id: "privacy",
    label: "Privacy & safety",
    icon: <EyeOff size={18} />,
    el: <PrivacySettings />,
  },
  {
    id: "security",
    label: "Security & sessions",
    icon: <ShieldCheck size={18} />,
    el: <SecuritySettings />,
  },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    icon: <Keyboard size={18} />,
    el: <ShortcutsSettings />,
  },
  { id: "about", label: "About", icon: <Info size={18} />, el: <AboutSettings /> },
];

export function SettingsView({ section }: { section?: string }) {
  // ADR 0007: an account whose identity an administrator has taken over is
  // offered no Identity & signatures section, and no route to one either.
  const identityLocked = useSession((s) => s.identityLocked);
  const sections = visibleSettingsSections(SECTIONS, identityLocked);
  const current = sections.find((s) => s.id === section);
  const [, navigate] = useLocation();
  useEffect(() => {
    if (identityLocked && section === IDENTITIES_SECTION)
      navigate("/settings/general", { replace: true });
  }, [identityLocked, section, navigate]);
  return (
    <SectionShell
      heading={t("Settings")}
      items={sections}
      activeId={section}
      base="/settings"
      backHref={section ? "/settings" : undefined}
      backLabel={t("All settings")}
      footer={
        <>
          <div className="nav-section" style={{ paddingLeft: 8 }}>
            <span>{t("Shortcuts")}</span>
          </div>
          <Link href="/contacts" className="nav-item">
            <Users size={18} />
            <span className="nav-label">{t("Address books")}</span>
          </Link>
        </>
      }
    >
      {current ? current.el : <GeneralSettings />}
    </SectionShell>
  );
}
