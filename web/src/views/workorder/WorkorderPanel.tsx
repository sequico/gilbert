/**
 * The workorder panel (ADR 0028): the surface a workorder is worked in.
 *
 * A large fixed panel, not a popover -- wide and tall enough to hold the open
 * workorder (its global checklist, the reader's own groups' checklists, and the
 * references it gathers) while the rest of the app is used beside it. The
 * launcher opens it; Escape and the close button put it away; on a phone it is
 * the full screen, the chat sheet's arrangement at a working size.
 *
 * The durable documents live in Stalwart -- the Master's root and one part per
 * group, joined by the uid -- and are read through the workorder route, never
 * through a Stalwart share (ADR 0028). This file is the view over the store:
 * the checklist a reader may check, and every reference by id, are the store's
 * answers, and nothing here composes a document of its own.
 */
import { ArrowLeft, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { formatFullDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import type {
  WorkorderCreateInput,
  WorkorderPartView,
  WorkorderRef,
  WorkorderRefKind,
  WorkorderScope,
  WorkorderState,
  WorkorderSummary,
} from "@/lib/workorder";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { openWorkorder, useWorkorders } from "@/store/workorder";
import { Spinner, useIsNarrow } from "@/ui/misc";
import { toast } from "@/ui/toast";

/*
 * States and reference kinds are held in constant tables and translated at the
 * render site, the convention the catalog check knows: the table's values are
 * English source text, and `t()` is what turns them into a reader's language.
 */
const STATE_LABELS: Record<WorkorderState, string> = {
  running: "Running",
  completed: "Completed",
  cancelled: "Cancelled",
  replaced: "Replaced",
};

const REF_KIND_LABELS: Record<WorkorderRefKind, string> = {
  folder: "Folder",
  file: "File",
  kb: "KB",
};

/**
 * One KB article offered as a checklist template: the article's identity, the
 * revision in force to bind to, and the title the picker shows.
 */
interface TemplateOption {
  accountId: string;
  id: string;
  revision: string;
  title: string;
}

/** The groups a workorder has a part for, deduplicated and in listing order. */
function partGroups(w: WorkorderSummary): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of w.parts) {
    if (part.scope !== "group" || !part.group || seen.has(part.group)) continue;
    seen.add(part.group);
    out.push(part.group);
  }
  return out;
}

function StateBadge({ state }: { state: WorkorderState }) {
  // Running is the live, accent-worthy one; the terminal states recede.
  return (
    <span className={`badge ${state === "running" ? "" : "muted"}`}>
      {t(STATE_LABELS[state])}
    </span>
  );
}

/**
 * One part's checklist: the global one or a group's.
 *
 * Every step is its template step's id plus its operational state, never the
 * controlled text, which is read from the template revision the checklist is
 * bound to (`part.labels`) and falls back to the id when the reader cannot
 * reach that revision. A step a reader may not check is disabled rather than
 * hidden: the checklist is the process, and reading it is still the point.
 */
function PartSection({
  part,
  onToggle,
}: {
  part: WorkorderPartView;
  onToggle: (
    scope: WorkorderScope,
    group: string | null,
    stepId: string,
    checked: boolean,
  ) => void;
}) {
  const title = part.scope === "global" ? t("Global") : (part.group ?? "");
  return (
    <section className="card workorder-part">
      <div className="card-head">
        <h3 className="grow truncate">{title}</h3>
      </div>
      {part.checklist.steps.length === 0 ? (
        <p className="hint">{t("No steps")}</p>
      ) : (
        <div className="workorder-steps">
          {part.checklist.steps.map((step) => {
            const done = step.state === "done";
            return (
              <label key={step.id} className={`workorder-step ${done ? "done" : ""}`}>
                <input
                  type="checkbox"
                  checked={done}
                  disabled={!part.canCheck}
                  onChange={(e) =>
                    onToggle(part.scope, part.group, step.id, e.target.checked)
                  }
                />
                <span className="workorder-step-label">
                  <span className="workorder-step-text">
                    {part.labels[step.id] ?? step.id}
                  </span>
                  {done && step.by && step.at && (
                    <span className="workorder-stamp">
                      {t("Checked by {who} on {when}", {
                        who: step.by,
                        when: formatFullDate(step.at),
                      })}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * The references a workorder gathers, and the administrator's control to add
 * one. A reference is `{accountId, kind, id}` and is followed by id -- nothing
 * is copied and nothing is planted in a work folder (ADR 0028).
 */
function RefsSection({
  refs,
  canAdminister,
  onAdd,
  onRemove,
}: {
  refs: WorkorderRef[];
  canAdminister: boolean;
  onAdd: (ref: WorkorderRef) => void;
  onRemove: (ref: WorkorderRef) => void;
}) {
  const [kind, setKind] = useState<WorkorderRefKind>("folder");
  const [id, setId] = useState("");
  const [accountId, setAccountId] = useState("");

  const ready = Boolean(id.trim() && accountId.trim());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    onAdd({ accountId: accountId.trim(), kind, id: id.trim() });
    setId("");
  };

  return (
    <section className="card">
      <div className="card-head">
        <h3>{t("References")}</h3>
      </div>
      {refs.length === 0 ? (
        <p className="hint">{t("No references yet")}</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {refs.map((ref) => (
            <li
              key={`${ref.kind}:${ref.accountId}:${ref.id}`}
              className="row"
              style={{ padding: "4px 0" }}
            >
              <span className="grow truncate">
                {t("{kind}: {id}", {
                  kind: t(REF_KIND_LABELS[ref.kind]),
                  id: ref.id,
                })}
              </span>
              {canAdminister && (
                <button
                  type="button"
                  className="icon-btn xs danger"
                  aria-label={t("Remove reference {id}", { id: ref.id })}
                  title={t("Remove reference {id}", { id: ref.id })}
                  onClick={() => onRemove(ref)}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canAdminister && (
        <form onSubmit={submit} style={{ marginTop: 10 }}>
          <div className="field-row">
            <div className="field">
              <label>{t("Kind")}</label>
              <select
                className="select"
                value={kind}
                onChange={(e) => setKind(e.target.value as WorkorderRefKind)}
              >
                <option value="folder">{t("Folder")}</option>
                <option value="file">{t("File")}</option>
                <option value="kb">{t("KB")}</option>
              </select>
            </div>
            <div className="field">
              <label>{t("ID")}</label>
              <input
                className="input"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder={t("ID")}
              />
            </div>
            <div className="field">
              <label>{t("Account")}</label>
              <input
                className="input"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder={t("Account")}
              />
            </div>
          </div>
          <button type="submit" className="btn btn-sm btn-soft" disabled={!ready}>
            <Plus size={14} /> {t("Add a reference")}
          </button>
        </form>
      )}
    </section>
  );
}

/**
 * The administrator's control to turn a workorder terminal. The store writes
 * the state and moves the Master's root; nothing here picks a successor's uid,
 * because `replaced` is a state a later concern completes.
 */
function CloseControl({ onClose }: { onClose: (state: WorkorderState) => void }) {
  return (
    <section className="card">
      <div className="card-head">
        <h3>{t("Close workorder")}</h3>
      </div>
      <div className="row">
        {(["completed", "cancelled", "replaced"] as const).map((state) => (
          <button
            key={state}
            type="button"
            className="btn btn-sm"
            onClick={() => onClose(state)}
          >
            {t(STATE_LABELS[state])}
          </button>
        ))}
      </div>
      <p className="hint" style={{ marginBottom: 0 }}>
        {t("A closed workorder is kept for ever.")}
      </p>
    </section>
  );
}

/**
 * The administrator's creation form: a friendly name, a KB template, and the
 * groups the workorder gets a part in.
 *
 * A template is offered only when it has a revision in force (ADR 0028): a
 * checklist is the operational instance of a revision, and one that was never
 * approved -- or whose first is still pending -- has nothing to bind. The KB
 * may not have been read in this session at all, so the form asks for it when
 * it appears rather than making a visit to /kb a precondition.
 */
function NewWorkorderForm({ groups }: { groups: string[] }) {
  const create = useWorkorders((s) => s.create);
  const [name, setName] = useState("");
  const [templateIdx, setTemplateIdx] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [knowledgeLoaded, setKnowledgeLoaded] = useState(false);

  /*
   * The template picker reads the KB, which may not have been loaded in a
   * session that never visited it. It is imported here rather than at module
   * scope on purpose: the KB store pulls its search index in, and this panel
   * sits in the shell's own chunk, which must not carry the KB into a session
   * that never opens one. The form is the only thing that needs it, and only
   * while an administrator has it on screen.
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [{ useKnowledge }, { revisionInForceAt }] = await Promise.all([
          import("@/store/knowledge"),
          import("@/lib/knowledge"),
        ]);
        // Always refresh: the picker must reflect what is in force now, not what
        // the session happened to load before an administrator approved a page.
        await useKnowledge.getState().load();
        if (!alive) return;
        setTemplates(
          useKnowledge.getState().tiers.flatMap((tier) =>
            tier.articles.flatMap((a) => {
              /*
               * The revision in force is the one a checklist may bind to, and it
               * is `revisionInForceAt`'s answer rather than `a.inForce`: a
               * revision approved for an instant that has since arrived is the
               * one in force, and the route refuses any other bind (ADR 0028).
               */
              const issued = revisionInForceAt(a);
              if (!issued) return [];
              return [
                {
                  accountId: tier.accountId,
                  id: a.id,
                  revision: issued.revision,
                  title: a.title,
                },
              ];
            }),
          ),
        );
      } catch {
        // A KB that cannot be read leaves the picker empty: creation is
        // unavailable rather than the form broken, and the hint says so.
      } finally {
        if (alive) setKnowledgeLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const chosen = templateIdx === "" ? null : (templates[Number(templateIdx)] ?? null);
  const ready = Boolean(name.trim() && chosen);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || !chosen) return;
    const input: WorkorderCreateInput = {
      name: name.trim(),
      template: {
        accountId: chosen.accountId,
        id: chosen.id,
        revision: chosen.revision,
      },
      groups: selected,
    };
    void create(input);
    setName("");
    setTemplateIdx("");
    setSelected([]);
  };

  return (
    <form className="card" onSubmit={submit} style={{ marginBottom: 0 }}>
      <div className="card-head">
        <h3>{t("New workorder")}</h3>
      </div>
      <div className="field">
        <label>{t("Name")}</label>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("Name")}
        />
      </div>
      <div className="field">
        <label>{t("Template")}</label>
        <select
          className="select"
          value={templateIdx}
          onChange={(e) => setTemplateIdx(e.target.value)}
        >
          <option value="">{t("Select a template")}</option>
          {templates.map((tpl, i) => (
            <option key={`${tpl.accountId}:${tpl.id}`} value={String(i)}>
              {tpl.title}
            </option>
          ))}
        </select>
        {knowledgeLoaded && templates.length === 0 && (
          <span className="hint">{t("No template with a revision in force")}</span>
        )}
      </div>
      {groups.length > 0 && (
        <div className="field">
          <label>{t("Groups")}</label>
          <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
            {groups.map((g) => (
              <label key={g} className="row" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  checked={selected.includes(g)}
                  onChange={(e) =>
                    setSelected((prev) =>
                      e.target.checked ? [...prev, g] : prev.filter((x) => x !== g),
                    )
                  }
                />
                <span className="truncate">{g}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      <button type="submit" className="btn btn-sm btn-primary" disabled={!ready}>
        {t("Create")}
      </button>
    </form>
  );
}

export function WorkorderPanel() {
  const workorders = useWorkorders((s) => s.workorders);
  const loaded = useWorkorders((s) => s.loaded);
  const loading = useWorkorders((s) => s.loading);
  const error = useWorkorders((s) => s.error);
  const load = useWorkorders((s) => s.load);
  const show = useWorkorders((s) => s.show);
  const closePanel = useWorkorders((s) => s.closePanel);
  const toggle = useWorkorders((s) => s.toggle);
  const close = useWorkorders((s) => s.close);
  const addRef = useWorkorders((s) => s.addRef);
  const removeRef = useWorkorders((s) => s.removeRef);

  const sessionAdmin = useSession((s) => s.session?.gilbert?.isAdmin === true);
  const mailAccounts = useMail((s) => s.mailAccounts);
  const groups = useMemo(
    () => groupMailboxAccounts(mailAccounts).map((a) => a.name),
    [mailAccounts],
  );

  const open = useWorkorders(openWorkorder);
  /*
   * The route decides in the end; this only decides what to offer. A summary
   * carries what the caller may administer, and the session's own admin flag
   * covers the window before the first list has landed.
   */
  const canAdminister =
    sessionAdmin ||
    (open?.canAdminister ?? false) ||
    workorders.some((w) => w.canAdminister);

  // A store error is shown once, where the reader already is; the panel keeps
  // the last state it had rather than blanking on a failed refresh.
  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closePanel();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [closePanel]);

  const [filter, setFilter] = useState<WorkorderState | "all">("all");
  const narrow = useIsNarrow();
  const filtered =
    filter === "all" ? workorders : workorders.filter((w) => w.state === filter);
  const filters = ["all", "running", "completed", "cancelled", "replaced"] as const;

  return createPortal(
    <div
      className="workorder-overlay"
      onMouseDown={(e) => {
        // A press on the backdrop puts the panel away, the dialog's own rule;
        // a press inside it stays.
        if (e.target === e.currentTarget) closePanel();
      }}
    >
      <div
        className="workorder-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("Workorders")}
      >
        <header className="workorder-head">
          {open && (
            <button
              type="button"
              className="icon-btn sm"
              aria-label={t("Back")}
              title={t("Back")}
              onClick={() => show(null)}
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <h2 className="workorder-title grow truncate">
            {open ? (
              // A workorder's name is the reader's own words, never translated.
              <span className="notranslate" translate="no">
                {open.name}
              </span>
            ) : (
              t("Workorders")
            )}
          </h2>
          {open && <StateBadge state={open.state} />}
          <button
            type="button"
            className="icon-btn sm"
            aria-label={t("Refresh")}
            title={t("Refresh")}
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw size={17} className={loading ? "spin" : undefined} />
          </button>
          <button
            type="button"
            className="icon-btn sm"
            aria-label={t("Close")}
            title={t("Close")}
            onClick={closePanel}
          >
            <X size={18} />
          </button>
        </header>

        <div className="workorder-body">
          {(!narrow || !open) && (
            <aside className="workorder-list-pane">
              <div className="workorder-filters">
                {filters.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={`chip ${filter === f ? "active" : ""}`}
                    onClick={() => setFilter(f)}
                  >
                    {f === "all" ? t("All") : t(STATE_LABELS[f])}
                  </button>
                ))}
              </div>
              <div className="workorder-scroll">
                {loading && !loaded ? (
                  <Spinner label={t("Loading…")} />
                ) : error && !loaded ? (
                  <div className="row" style={{ flexDirection: "column", gap: 10 }}>
                    <div>{t("Could not load the workorders")}</div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void load()}
                    >
                      {t("Retry")}
                    </button>
                  </div>
                ) : filtered.length === 0 ? (
                  <p className="hint">{t("No workorders yet")}</p>
                ) : (
                  <div className="workorder-list">
                    {filtered.map((w) => {
                      const gs = partGroups(w);
                      return (
                        <div
                          key={w.uid}
                          role="button"
                          tabIndex={0}
                          className={`card clickable ${open?.uid === w.uid ? "active" : ""}`}
                          style={{ textAlign: "left", marginBottom: 0 }}
                          onClick={() => show(w.uid)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              show(w.uid);
                            }
                          }}
                        >
                          <div className="card-head">
                            <h3 className="grow truncate">{w.name}</h3>
                            <StateBadge state={w.state} />
                          </div>
                          <div className="hint" style={{ marginTop: 6 }}>
                            {gs.length
                              ? t("Groups: {groups}", { groups: gs.join(", ") })
                              : t("Global")}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {canAdminister && (
                  <div style={{ marginTop: 16 }}>
                    <NewWorkorderForm groups={groups} />
                  </div>
                )}
              </div>
            </aside>
          )}

          {(!narrow || open) && (
            <section className="workorder-detail-pane">
              <div className="workorder-scroll">
                {open ? (
                  <>
                    {open.parts.map((part) => (
                      <PartSection
                        key={part.scope === "global" ? "global" : (part.group ?? "group")}
                        part={part}
                        onToggle={(scope, group, stepId, checked) =>
                          void toggle(open.uid, scope, group, stepId, checked)
                        }
                      />
                    ))}
                    <RefsSection
                      refs={open.refs}
                      canAdminister={canAdminister}
                      onAdd={(ref) => void addRef(open.uid, ref)}
                      onRemove={(ref) => void removeRef(open.uid, ref)}
                    />
                    {canAdminister && (
                      <CloseControl onClose={(state) => void close(open.uid, state)} />
                    )}
                  </>
                ) : (
                  <p className="hint">{t("Select a workorder, or create one.")}</p>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
