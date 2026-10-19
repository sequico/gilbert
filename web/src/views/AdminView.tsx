import {
  Bot,
  Code,
  Info,
  KeyRound,
  ScrollText,
  ServerCog,
  ShieldCheck,
  Tag,
  UserCog,
} from "lucide-react";
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { type SectionGroup, type SectionItem, SectionShell } from "@/ui/SectionShell";
import { AdminAgent } from "@/views/admin/AdminAgent";
import { AdminInstallation } from "@/views/admin/AdminInstallation";
import { AdminPolicy } from "@/views/admin/AdminPolicy";
import { AdminUsers } from "@/views/admin/AdminUsers";
import { GroupLabels } from "@/views/admin/GroupLabels";
import { Identities } from "@/views/admin/Identities";
import { RulesPanel } from "@/views/admin/RulesPanel";
import { SystemSieve } from "@/views/admin/SystemSieve";
import { AboutSettings } from "@/views/settings/AboutSettings";

type AdminOwner = "mailer" | "stalwart" | null;
type AdminSection = SectionItem & { el: ReactNode; owner: AdminOwner };

/**
 * The administration's groups, and what each one is for.
 *
 * "Gilbert Mailer" is the mail server's own administration — policy, the
 * installation's own document (ADR 0011), **the installation's agent** (where it
 * is, the runs its groups have worked, the facts it reasons from), the group
 * label catalogs, forced password changes, and **Identities**,
 * one section holding a person's and a group's behind two tabs (ADR 0007) —
 * the surfaces ADR 0001/0005 cover.
 * "Stalwart"
 * is the mail server's own records, written over JMAP: **System Sieve**, its
 * trusted, server-wide Sieve scripts (ADR 0008). The
 * split keeps each kind of thing under a heading that names it,
 * rather than both under one unlabelled "Gilbert".
 */
function sections(): AdminSection[] {
  return [
    {
      id: "policy",
      label: "Policy",
      icon: <ShieldCheck size={18} />,
      el: <AdminPolicy />,
      owner: "mailer",
    },
    {
      id: "installation",
      label: t("Installation"),
      icon: <ServerCog size={18} />,
      el: <AdminInstallation />,
      owner: "mailer",
    },
    {
      id: "agent",
      label: t("Agent"),
      icon: <Bot size={18} />,
      el: <AdminAgent />,
      owner: "mailer",
    },
    {
      id: "rules",
      label: t("Rules"),
      icon: <ScrollText size={18} />,
      el: <RulesPanel />,
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
      id: "identities",
      label: t("Identities"),
      icon: <UserCog size={18} />,
      el: <Identities />,
      owner: "mailer",
    },
    {
      id: "system-sieve",
      label: t("System Sieve"),
      icon: <Code size={18} />,
      el: <SystemSieve />,
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
 * "Gilbert Mailer" for the mail server's own administration (policy, the
 * installation document, the installation's agent, forced passwords, group label
 * catalogs, and the
 * identities an administrator sets as one section with a tab per kind of
 * principal, ADR 0007), and "Stalwart"
 * for the mail server's own records — its trusted,
 * server-wide Sieve scripts (ADR 0008) — with About ungrouped at the tail.
 */
export function AdminView({ section }: { section?: string }) {
  const adminSections = sections();
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
