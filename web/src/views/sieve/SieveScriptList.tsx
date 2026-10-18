import { errorMessage } from "@gilbert/shared/errors";
import { Power, Trash2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { confirmDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";

/**
 * One row of a Sieve script list, and the three things a reader can do to it.
 *
 * Two lists are the same list: the server-wide scripts an installation
 * administers (`../admin/SystemSieve.tsx`) and a person's own filters
 * (`../settings/FiltersSettings.tsx`). Both draw a card carrying the name, the
 * active mark, Edit, Activate/Deactivate and a delete that asks first — the
 * card was written out in both, along with the toast on a failed write and the
 * confirmation before a delete, which is the half that matters: a script that
 * refuses to run for the whole installation is not the same thing to lose as one
 * of somebody's own filters, and both are lost the same way, by a click.
 *
 * The three actions are parameters because what each list writes is not the
 * same: the admin's carries the list's `state` so Stalwart refuses a write
 * built on a since-changed read, while the account's store settles its own.
 * What a reader sees and the way a failure is reported are the card's, and are
 * here once.
 */
interface SieveScriptRow {
  id: string;
  name: string;
  isActive: boolean;
  description?: string | null;
}

export function SieveScriptList<T extends SieveScriptRow>({
  scripts,
  onEdit,
  onToggle,
  onDelete,
}: {
  scripts: readonly T[];
  onEdit: (script: T) => void;
  /** Arm or disarm the script; the caller carries whatever its write needs. */
  onToggle: (script: T) => Promise<void>;
  onDelete: (script: T) => Promise<void>;
}) {
  return (
    <>
      {scripts.map((s) => (
        <div key={s.id} className="card">
          <div className="card-head">
            <h3>
              <span>{s.name} </span>
              {s.isActive && (
                <span className="tag" style={{ background: "var(--success)" }}>
                  {t("active")}
                </span>
              )}
            </h3>
            <button className="btn btn-sm" onClick={() => onEdit(s)}>
              {t("Edit")}
            </button>
            <button
              className="btn btn-sm"
              onClick={async () => {
                try {
                  await onToggle(s);
                } catch (err) {
                  toast.error(errorMessage(err));
                }
              }}
            >
              <Power size={14} /> {s.isActive ? t("Deactivate") : t("Activate")}
            </button>
            <button
              className="icon-btn sm danger"
              aria-label={t("Delete script")}
              onClick={async () => {
                if (
                  await confirmDialog({
                    title: t("Delete script “{name}”?", { name: s.name }),
                    confirmLabel: t("Delete"),
                    danger: true,
                  })
                ) {
                  try {
                    await onDelete(s);
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }
              }}
            >
              <Trash2 size={16} />
            </button>
          </div>
          {s.description && <p className="hint">{s.description}</p>}
        </div>
      ))}
    </>
  );
}
