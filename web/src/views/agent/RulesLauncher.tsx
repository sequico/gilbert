/**
 * The rules launcher (ADR 0035): the top-bar entry to a group's prose.
 *
 * A group's rules and its standing instruction are the group's own documents,
 * written by a member with the group's session — the same place its chat is
 * written. The surface sits beside chat's and the workorder's, offered only when
 * the session holds a group mailbox **and** the reader is an installation
 * administrator: a group's prose is decided by an administrator and by nobody
 * else (owner decision 2026-10-18). It opens a dialog rather than a popover: the
 * editor is a form, and a form in a popover beside a top bar closes itself while
 * somebody is typing in it.
 */
import { ScrollText } from "lucide-react";
import { useState } from "react";
import { mayAdminister } from "@/lib/administer";
import { t } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { RulesDialog } from "./RulesDialog";

export function RulesLauncher() {
  const [open, setOpen] = useState(false);
  const groups = groupMailboxAccounts(useMail((s) => s.mailAccounts));
  // Only an installation administrator decides a group's prose (owner decision
  // 2026-10-18). This is the surface's own rule, and the boundary is the group's
  // grants: a member who can write the account can still write the documents.
  const admin = mayAdminister(useSession((s) => s.session?.gilbert));
  if (!groups.length || !admin) return null;
  return (
    <>
      <button
        type="button"
        className="icon-btn"
        aria-label={t("Rules")}
        title={t("Rules")}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <ScrollText size={20} />
      </button>
      <RulesDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
