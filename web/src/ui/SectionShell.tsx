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

export function SectionShell({
  heading,
  items,
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
  return (
    <div className={`settings-layout ${activeId ? "section" : "root"}`}>
      <nav
        className="settings-nav"
        aria-label={typeof heading === "string" ? heading : undefined}
      >
        <div className="nav-section" style={{ paddingLeft: 8 }}>
          <span>{heading}</span>
        </div>
        {items.map((s) => (
          <Link
            key={s.id}
            href={`${base}/${s.id}`}
            className={`nav-item ${activeId === s.id ? "active" : ""}`}
          >
            {s.icon}
            <span className="nav-label">{t(s.label)}</span>
          </Link>
        ))}
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
