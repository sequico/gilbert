import { Play } from "lucide-react";
import { t } from "@/lib/i18n";
import { SieveEditor } from "@/ui/SieveEditor";

/**
 * The Sieve script form, shared by the two surfaces that edit one.
 *
 * A person's own filters (`ScriptsEditor` in
 * `views/settings/FiltersSettings.tsx`) and Stalwart's server-wide system
 * scripts (`views/admin/SystemSieve.tsx`) are different objects in different
 * places, reached through different writes — which is why the *lists* stay
 * apart. The form is not: the name, the optional description, the source, the
 * unsaved-changes mark and the Cancel / Save / Save & activate bar are one piece
 * of markup, including the disabled name on a script that exists — its name is
 * how Stalwart addresses it, and neither surface may edit it.
 *
 * The surface hands in a `SieveScriptForm` and keeps everything that makes it
 * itself: what it loads, what saving does, and — the one visible difference —
 * the personal tab's own *Validate*, which the system door has no call for
 * because `x:SieveSystemScript/set` compiles on save. That is why `onValidate`
 * and `validation` are optional and nothing here asks whether a script is
 * active: `onSave` is what that surface means by saving (the system list keeps
 * a script's own state), and `onSaveActivate` is the other button.
 */
export interface SieveScriptForm {
  name: string;
  setName: (value: string) => void;
  /** True for a script that exists: its name is its address, so it is fixed. */
  nameLocked: boolean;
  /** The description, where the surface keeps one. The field is drawn if it is. */
  description?: string;
  setDescription?: (value: string) => void;
  content: string;
  setContent: (value: string) => void;
  /** The form differs from what it opened with. */
  dirty: boolean;
  /** A write is in flight: the buttons go dead until it answers. */
  busy: boolean;
  /** Save, as this surface means it. */
  onSave: () => void;
  /** Save and make the script active. */
  onSaveActivate: () => void;
  onClose: () => void;
  /** The surface's own preflight, where it has one. */
  onValidate?: () => void;
  /** What that preflight last said, shown above the bar. */
  validation?: string | null;
}

export function SieveScriptPanel({ form }: { form: SieveScriptForm }) {
  return (
    <div>
      <div className="field">
        <label>{t("Script name")}</label>
        <input
          className="input"
          value={form.name}
          onChange={(e) => form.setName(e.target.value)}
          disabled={form.nameLocked}
        />
      </div>
      {form.description !== undefined && (
        <div className="field">
          <label>{t("Description")}</label>
          <input
            className="input"
            value={form.description}
            onChange={(e) => form.setDescription?.(e.target.value)}
          />
        </div>
      )}
      <div className="field">
        <label>{t("Sieve source")}</label>
        <SieveEditor value={form.content} onChange={form.setContent} minHeight={320} />
      </div>
      {form.validation && <div className="error-box mb-16">{form.validation}</div>}
      <div className="row save-bar">
        <button className="btn btn-ghost" onClick={form.onClose}>
          {t("Cancel")}
        </button>
        {form.onValidate && (
          <button className="btn" disabled={form.busy} onClick={form.onValidate}>
            <Play size={14} /> {t("Validate")}
          </button>
        )}
        <span className="spacer" />
        {form.dirty && <span className="unsaved">{t("Unsaved changes")}</span>}
        <button className="btn" disabled={form.busy} onClick={form.onSave}>
          {t("Save")}
        </button>
        <button
          className="btn btn-primary"
          disabled={form.busy}
          onClick={form.onSaveActivate}
        >
          {t("Save & activate")}
        </button>
      </div>
    </div>
  );
}
