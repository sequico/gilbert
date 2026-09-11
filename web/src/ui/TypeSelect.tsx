/**
 * A single select you type into: a text field, and the options that match what
 * has been typed, in flow beneath it.
 *
 * The pickers on the administration's identity surfaces choose an account or a
 * group mailbox out of a directory that can be long, and the value they want is
 * sometimes one the directory does not list at all — an address an administrator
 * knows. So the typed text filters, and with `allowFreeText` the text itself is
 * the value, the way the force-password surface's "Or type an address" works.
 *
 * It reads as a field, not a popup: the list is in flow, so it starts open and a
 * page that offers a picker shows what there is to pick. Escape closes it,
 * picking an option or pressing Enter commits, and the chosen value can be
 * cleared.
 */

import { X } from "lucide-react";
import { useState } from "react";
import { t } from "@/lib/i18n";

export interface TypeSelectOption {
  value: string;
  /** What to show for the value; the value itself when there is none. */
  label?: string;
}

/** The options whose value or label contains `query`, case-insensitively. */
export function filterTypeSelectOptions(
  options: TypeSelectOption[],
  query: string,
): TypeSelectOption[] {
  const want = query.trim().toLowerCase();
  if (!want) return options;
  return options.filter(
    (o) =>
      o.value.toLowerCase().includes(want) ||
      (o.label ?? "").toLowerCase().includes(want),
  );
}

export function TypeSelect({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  disabled,
  allowFreeText,
}: {
  value: string;
  onChange: (v: string) => void;
  options: TypeSelectOption[];
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** The typed text is the value, for what the directory does not list. */
  allowFreeText?: boolean;
}) {
  /** What is being typed; `null` means the field shows the chosen value. */
  const [typed, setTyped] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const chosen = options.find((o) => o.value === value);
  // A value the directory does not list has no label to show, so it shows as
  // itself rather than vanishing the moment the typing stops.
  const shown = typed ?? (chosen ? (chosen.label ?? chosen.value) : value);
  const matches = filterTypeSelectOptions(options, typed ?? "");

  const pick = (v: string) => {
    setTyped(null);
    setOpen(false);
    onChange(v);
  };

  /** Take what was typed: the option it names, or — where allowed — itself. */
  const commit = () => {
    if (typed === null) return;
    const want = typed.trim();
    const named = options.find((o) => o.value.toLowerCase() === want.toLowerCase());
    if (named) pick(named.value);
    else if (allowFreeText && want) pick(want);
    else setTyped(null);
  };

  return (
    <div className="field">
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <input
          className="input"
          value={shown}
          placeholder={placeholder}
          aria-label={ariaLabel}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          aria-autocomplete="list"
          aria-expanded={open}
          onFocus={(e) => {
            setOpen(true);
            e.currentTarget.select();
          }}
          onChange={(e) => {
            setTyped(e.target.value);
            setOpen(true);
          }}
          onBlur={() => setTyped(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              setTyped(null);
              setOpen(false);
            }
          }}
        />
        {value !== "" && !disabled && (
          <button
            className="icon-btn sm"
            aria-label={t("Clear")}
            onClick={() => {
              setTyped(null);
              onChange("");
            }}
          >
            <X size={16} />
          </button>
        )}
      </div>
      {open && !disabled && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          style={{
            maxHeight: 240,
            overflowY: "auto",
            padding: 4,
            background: "var(--bg-elev)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius-sm)",
            boxShadow: "var(--shadow-1)",
          }}
        >
          {matches.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`nav-item ${o.value === value ? "active" : ""}`}
              style={{ width: "100%" }}
              // Keep the field's focus, so picking a row is a click and not a
              // blur first: the blur would drop the filter under the pointer.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o.value)}
            >
              <span className="nav-label">{o.label ?? o.value}</span>
              {o.label && o.label !== o.value && (
                <span className="nav-count">{o.value}</span>
              )}
            </button>
          ))}
          {!matches.length && (
            <div className="hint" style={{ padding: "8px 12px" }}>
              {allowFreeText
                ? t(
                    "Nothing in the directory matches. Press Enter to use what you typed.",
                  )
                : t("Nothing matches.")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
