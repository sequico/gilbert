import { t } from "@/lib/i18n";
import { UI_LANGUAGES } from "@/lib/languages";

/**
 * The picker of shipped interface languages.
 *
 * The option list is `UI_LANGUAGES` — the registry that also decides which
 * catalogues may load — rendered here once. The sign-in form and Appearance
 * both offer it, and a second loop over the registry is a second place for the
 * two to drift apart.
 */
export function LanguageSelect({
  id,
  value,
  label,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  /** A visible label; omitted, the control is named for assistive tech only. */
  label?: string;
  disabled?: boolean;
  onChange: (tag: string) => void;
}) {
  return (
    <>
      {label ? <label htmlFor={id}>{label}</label> : null}
      <select
        id={id}
        className="select"
        aria-label={label ? undefined : t("Interface language")}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {UI_LANGUAGES.map((l) => (
          <option key={l.tag} value={l.tag}>
            {l.beta ? t("{name} (Beta)", { name: l.name }) : l.name}
          </option>
        ))}
      </select>
    </>
  );
}
