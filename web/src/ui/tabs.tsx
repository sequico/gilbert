import type { KeyboardEvent } from "react";
import { t } from "@/lib/i18n";

/**
 * A strip of tabs over one shared panel, and the keyboard rule that goes with it.
 *
 * Two administration surfaces are tabs — the installation's own agent, and one
 * group's — and each wrote the strip, the arrow-key handler and the four ARIA
 * attributes by hand. The attributes are the reason this is one component: only
 * the selected tab may carry `aria-controls`, or a screen reader reading an
 * inactive tab is sent to a panel that is not its own, and that mistake is
 * invisible in a screenshot.
 *
 * `idPrefix` is what keeps two strips on one page apart, since both render a
 * panel and both name their tabs in the document.
 */
export interface TabPart<Id extends string = string> {
  id: Id;
  /** English source; rendered through `t()` where the tab is drawn. */
  label: string;
}

export function TabStrip<Id extends string>({
  parts,
  selected,
  onSelect,
  idPrefix,
  label,
}: {
  parts: readonly TabPart<Id>[];
  selected: Id;
  onSelect: (id: Id) => void;
  idPrefix: string;
  /**
   * The strip's own name, for a reader arriving at it — English source,
   * translated where it is drawn, so the catalogue check can still find the key.
   */
  label: string;
}) {
  /*
   * The strip is one stop in the tab order and the arrows move between the tabs,
   * rather than every tab being its own stop.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const at = parts.findIndex((entry) => entry.id === selected);
    const next = parts[(at + step + parts.length) % parts.length];
    if (!next) return;
    onSelect(next.id);
    document.getElementById(`${idPrefix}-${next.id}`)?.focus();
  };

  return (
    <div
      className="segmented agent-tabs"
      role="tablist"
      aria-label={t(label)}
      onKeyDown={onKeyDown}
    >
      {parts.map((entry) => (
        <button
          key={entry.id}
          id={`${idPrefix}-${entry.id}`}
          type="button"
          role="tab"
          aria-selected={selected === entry.id}
          // One shared panel, so only the selected tab names it: a reference
          // from an inactive tab would point at a panel that is not its own.
          aria-controls={selected === entry.id ? `${idPrefix}panel` : undefined}
          tabIndex={selected === entry.id ? 0 : -1}
          className={selected === entry.id ? "active" : ""}
          onClick={() => onSelect(entry.id)}
        >
          {t(entry.label)}
        </button>
      ))}
    </div>
  );
}

/** The panel a `TabStrip` names, with the attributes that tie it back. */
export function TabPanel<Id extends string>({
  idPrefix,
  selected,
  style,
  children,
}: {
  idPrefix: string;
  selected: Id;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}panel`}
      aria-labelledby={`${idPrefix}-${selected}`}
      tabIndex={-1}
      style={style}
    >
      {children}
    </div>
  );
}
