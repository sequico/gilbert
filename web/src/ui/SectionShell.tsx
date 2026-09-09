import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Suspense } from "react";
import { Link, useLocation } from "wouter";
import { t } from "@/lib/i18n";
import { Spinner } from "@/ui/misc";

/**
 * The two-pane layout every settings-like surface shares: a left navigation
 * column of sections and the section content beside it.
 *
 * This is the single copy of that shell — Settings, Administration and any
 * future surface render through it rather than duplicating the markup. The
 * CSS classes are the original settings ones, so styling is shared too.
 *
 * The heading and the back label are translated **at the call site** and
 * passed in as already-localised ReactNodes: they are plain props here, and
 * an English key that only ever travels through a prop would otherwise look
 * stale to the i18n extraction (nothing renders it through `t()` with the
 * literal in sight).
 */
export interface SectionItem {
  id: string;
  label: string;
  icon: ReactNode;
}

/** A labelled run of nav items; see `groups`. */
export interface SectionGroup {
  /** Group heading; translated by the caller. */
  label?: ReactNode;
  /** Rendered under the heading when the group has no items yet. */
  emptyLabel?: ReactNode;
  items: SectionItem[];
}

export function SectionShell({
  heading,
  items,
  groups,
  activeId,
  base,
  children,
  footer,
  backHref,
  backLabel,
}: {
  /** The nav column's label; translated by the caller. */
  heading: ReactNode;
  items: SectionItem[];
  /**
   * Labelled groups of items. When present they render under the heading in
   * place of `items`, and `items` render after the groups as the ungrouped
   * tail (About, cross-links). Settings passes plain `items`; Administration
   * groups its surfaces by owner (Gilbert vs Stalwart, ADR 0007).
   */
  groups?: SectionGroup[];
  /** Which item is active; undefined renders the "root" container class. */
  activeId?: string;
  /** Prefix every item link: `${base}/${id}`. */
  base: string;
  children: ReactNode;
  /** Extra nav content after the items (labels, cross-links). */
  footer?: ReactNode;
  /** When set, the "back to the root" button appears above the content. */
  backHref?: string;
  /** Label for that button; translated by the caller. */
  backLabel?: ReactNode;
}) {
  const [, navigate] = useLocation();
  const renderItems = (list: SectionItem[]) =>
    list.map((s) => (
      <Link
        key={s.id}
        href={`${base}/${s.id}`}
        className={`nav-item ${activeId === s.id ? "active" : ""}`}
      >
        {s.icon}
        <span className="nav-label">{t(s.label)}</span>
      </Link>
    ));
  const grouped = groups && groups.length > 0;
  return (
    <div className={`settings-layout ${activeId ? "section" : "root"}`}>
      <nav
        className="settings-nav"
        aria-label={typeof heading === "string" ? heading : undefined}
      >
        <div className="nav-section" style={{ paddingLeft: 8 }}>
          <span>{heading}</span>
        </div>
        {grouped
          ? groups!.map((g) => (
              <div key={typeof g.label === "string" ? g.label : "group"}>
                {g.label && (
                  <div className="nav-section">
                    <span>{g.label}</span>
                  </div>
                )}
                {g.items.length > 0
                  ? renderItems(g.items)
                  : g.emptyLabel && <p className="hint nav-empty">{g.emptyLabel}</p>}
              </div>
            ))
          : renderItems(items)}
        {grouped && items.length > 0 && (
          <div
            style={{
              marginTop: 8,
              borderTop: "1px solid var(--border)",
              paddingTop: 4,
            }}
          >
            {renderItems(items)}
          </div>
        )}
        {footer}
      </nav>
      <div className="settings-content">
        {backHref && (
          <button
            className="btn btn-ghost btn-sm"
            style={{ marginBottom: 8, marginLeft: -8 }}
            onClick={() => navigate(backHref)}
          >
            <ArrowLeft size={16} /> {backLabel}
          </button>
        )}
        <Suspense fallback={<Spinner />}>{children}</Suspense>
      </div>
    </div>
  );
}
