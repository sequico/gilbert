import { Fragment, type KeyboardEvent, type ReactNode } from "react";

/**
 * The one tab strip: a row of tabs over a panel its surface renders.
 *
 * Three surfaces draw this row — the identities pair, the agent's views and
 * groups, and the chat switcher — and each wrote the role, the roving tab stop
 * and the arrow keys by hand. The attributes are why it is one component: only
 * one tab may be in the tab order, and a mis-wired `aria-controls` is invisible
 * in a screenshot.
 *
 * The panels stay the surface's own, because the three arrange them
 * differently: identities keeps both mounted so a tab keeps what it was in the
 * middle of (ADR 0005), the agent mounts one when it is first visited, and the
 * chat switcher swaps the one thread below it. `panelId` is how a tab names the
 * panel it controls: the id its surface gave the element, or null when there is
 * no per-tab panel to name.
 */
export interface TabEntry {
  /** What the tab is, in the strip's ids and in `selected`. */
  id: string;
  /** What the tab says. */
  content: ReactNode;
  /** A node drawn in the same row before this tab — a heading for what follows. */
  before?: ReactNode;
}

/** The id a tab's element carries, from the strip's prefix and the entry's id. */
export function tabElementId(idPrefix: string, id: string): string {
  return `${idPrefix}-${id}`;
}

export function TabStrip({
  label,
  tabs,
  selected,
  onSelect,
  idPrefix,
  panelId = (id) => `${idPrefix}-${id}-panel`,
  className = "tabs",
  tabClassName = () => "tab",
}: {
  /** The strip's own name for a reader arriving at it, translated where it is passed. */
  label: string;
  tabs: readonly TabEntry[];
  selected: string;
  onSelect: (id: string) => void;
  /** What keeps two strips on one page apart in the document's ids. */
  idPrefix: string;
  /** The panel a tab controls, or null when the strip has no per-tab panel. */
  panelId?: (id: string) => string | null;
  className?: string;
  /** The class of one tab — a surface that draws its tabs differently says so here. */
  tabClassName?: (entry: TabEntry, selected: boolean) => string;
}) {
  /*
   * The strip is one stop in the tab order and the arrows move between the
   * tabs, rather than every tab being its own stop.
   */
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const at = tabs.findIndex((entry) => entry.id === selected);
    if (at < 0) return;
    const next = tabs[(at + step + tabs.length) % tabs.length];
    if (!next) return;
    onSelect(next.id);
    document.getElementById(tabElementId(idPrefix, next.id))?.focus();
  };

  return (
    <div className={className} role="tablist" aria-label={label} onKeyDown={move}>
      {tabs.map((entry) => (
        <Fragment key={entry.id}>
          {entry.before}
          <button
            id={tabElementId(idPrefix, entry.id)}
            type="button"
            role="tab"
            className={tabClassName(entry, entry.id === selected)}
            aria-selected={entry.id === selected}
            aria-controls={panelId(entry.id) ?? undefined}
            tabIndex={entry.id === selected ? 0 : -1}
            onClick={() => onSelect(entry.id)}
          >
            {entry.content}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
