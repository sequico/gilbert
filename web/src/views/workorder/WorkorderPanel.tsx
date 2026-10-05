/**
 * The workorder panel (ADR 0028): the surface a workorder is worked in.
 *
 * A large fixed panel, not a popover -- wide and tall enough to hold the open
 * workorder (its global checklist and the reader's own groups' checklists)
 * while the rest of the app is used beside it. The
 * launcher opens it; Escape and the close button put it away; on a phone it is
 * the full screen, the chat sheet's arrangement at a working size.
 *
 * The durable documents live in Stalwart -- the Master's root and one part per
 * group, joined by the uid -- and are read through the workorder route, never
 * through a Stalwart share (ADR 0028). This file is the view over the store:
 * the checklist a reader may check, and every reference by id, are the store's
 * answers, and nothing here composes a document of its own.
 *
 * A checklist is not a flat list. The server resolves the template revision the
 * checklist is bound to against the workorder's chosen variant values and its
 * chosen items (ADR 0030) and answers `groups`: one per applicable section,
 * each holding the items that apply -- the single item of a plain section, one
 * per named item of a repeated one -- and each item its steps. The controlled
 * text of every step, item and section is read from that revision and never
 * stored on the workorder, so this file renders what it is handed.
 */
import type { KnowledgeChecklist, KnowledgeRepeat } from "@gilbert/shared/knowledge";
import { ArrowLeft, MoreHorizontal, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { formatFullDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  isStepComplete,
  type WorkorderCreateInput,
  type WorkorderItemInput,
  type WorkorderPartView,
  type WorkorderScope,
  type WorkorderState,
  type WorkorderStepState,
  type WorkorderStepView,
  type WorkorderSummary,
} from "@/lib/workorder";
import { useSession } from "@/store/session";
import { openWorkorder, useWorkorders } from "@/store/workorder";
import { Spinner, useIsNarrow } from "@/ui/misc";
import { MenuItem, Popover, useMenu } from "@/ui/popover";
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

/* The four states a step reaches; translated at the render site. `done` and
   `skipped` count as complete, `open` and `not-applicable` do not. */
const STEP_STATE_LABELS: Record<WorkorderStepState, string> = {
  open: "Open",
  done: "Done",
  skipped: "Skipped",
  "not-applicable": "Not applicable",
};

/**
 * One KB article offered as a checklist template: the article's identity, the
 * revision in force to bind to, the title the picker shows, and where the
 * revision is read from when the template is chosen.
 */
interface TemplateOption {
  scope: "company" | "group";
  accountId: string;
  id: string;
  revision: string;
  title: string;
  /** The article folder path within its tier, for the read that fetches rules. */
  folder: string;
  /** The article folder node id, the group tier's read key. */
  nodeId: string;
  /** The parent article node id, as the group tier's read expects it. */
  parentId: string | null;
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

/** Every step of a part, flattened from its sections and items. */
function partSteps(part: WorkorderPartView): WorkorderStepView[] {
  return part.groups.flatMap((group) => group.items.flatMap((item) => item.steps));
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
 * One step: its controlled label, its state and last signature.
 *
 * The checkbox is the ordinary done/open toggle; the menu reaches the two
 * states a checkbox cannot say -- `skipped`, which counts as complete but says
 * so, and `not-applicable`, which does not. A skipped or not-applicable step
 * carries a free-text note, edited inline, and every touched step shows who
 * set it and when. A step a reader may not check is disabled rather than
 * hidden: the checklist is the process, and reading it is still the point.
 */
function StepRow({
  step,
  canCheck,
  onCheck,
}: {
  step: WorkorderStepView;
  canCheck: boolean;
  onCheck: (path: string, state: WorkorderStepState, note?: string) => void;
}) {
  const menu = useMenu();
  const [note, setNote] = useState(step.note);

  // A state the server signed replaces the local edit, so the field never
  // shows a value the document no longer carries.
  useEffect(() => setNote(step.note), [step.note]);

  const complete = isStepComplete(step.state);
  const needsNote = step.state === "skipped" || step.state === "not-applicable";
  const commitNote = () => {
    if (note !== step.note) onCheck(step.path, step.state, note);
  };

  return (
    <div
      className={`workorder-step ${complete ? "done" : ""} ${
        step.state === "skipped" ? "skipped" : ""
      }`}
      style={step.state === "not-applicable" ? { opacity: 0.6 } : undefined}
    >
      {/* The toggle is complete/incomplete, so a skipped step shows checked:
          it counts as done and the menu's tick is where the two tell apart. */}
      <input
        type="checkbox"
        checked={complete}
        disabled={!canCheck}
        aria-label={step.label}
        onChange={(e) => onCheck(step.path, e.target.checked ? "done" : "open")}
      />
      <span className="workorder-step-label">
        <span className="workorder-step-text">{step.label}</span>
        {needsNote && (
          <input
            className="input"
            style={{ display: "block", marginTop: 4, width: "100%" }}
            value={note}
            placeholder={t("Why?")}
            disabled={!canCheck}
            onChange={(e) => setNote(e.target.value)}
            onBlur={commitNote}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitNote();
              }
            }}
          />
        )}
        {step.by && step.at && (
          <span className="workorder-stamp">
            {t("Set by {who} on {when}", {
              who: step.by,
              when: formatFullDate(step.at),
            })}
          </span>
        )}
      </span>
      <button
        type="button"
        className="icon-btn xs"
        disabled={!canCheck}
        aria-haspopup="menu"
        aria-label={t("Set state")}
        title={t("Set state")}
        onClick={menu.open}
      >
        <MoreHorizontal size={16} />
      </button>
      <Popover
        anchor={menu.anchor}
        onClose={menu.close}
        trigger={menu.trigger}
        ariaLabel={t("Set state")}
      >
        {(["done", "skipped", "not-applicable", "open"] as const).map((state) => (
          <MenuItem
            key={state}
            label={t(STEP_STATE_LABELS[state])}
            checked={step.state === state}
            onClick={() => {
              menu.close();
              onCheck(step.path, state, needsNote ? note : undefined);
            }}
          />
        ))}
      </Popover>
    </div>
  );
}

/**
 * One part's checklist: the global one or a group's.
 *
 * The part arrives grouped by the template's sections (ADR 0030): a plain
 * section holds its steps once; a repeated section holds one labelled block per
 * chosen item, its own data fields beside the name, and each block its steps.
 * Progress counts the states that finish a job -- `done` and `skipped` -- and
 * leaves `not-applicable` out.
 */
function PartSection({
  part,
  onCheck,
}: {
  part: WorkorderPartView;
  onCheck: (
    scope: WorkorderScope,
    group: string | null,
    path: string,
    state: WorkorderStepState,
    note?: string,
  ) => void;
}) {
  const title = part.scope === "global" ? t("Global") : (part.group ?? "");
  const steps = partSteps(part);
  const total = steps.length;
  const complete = steps.filter((step) => isStepComplete(step.state)).length;
  const check = (path: string, state: WorkorderStepState, note?: string) =>
    onCheck(part.scope, part.group, path, state, note);

  return (
    <section className="card workorder-part">
      <div className="card-head">
        <h3 className="truncate">{title}</h3>
        {/* The part's progress, beside its name: done/total. Formatting, not
            prose -- no catalogue key. `partSteps` and `isStepComplete` are the
            same two the step rows count with, so this cannot drift from them. */}
        {total > 0 && (
          <span className="hint">
            {complete}/{total}
          </span>
        )}
        <span className="grow" />
        {/* The KB page this checklist instantiates, named: a workorder's steps
            are a template's, and the reader can see which. */}
        {part.templateTitle && (
          <span className="hint truncate" title={part.templateTitle}>
            {t("From {template}", { template: part.templateTitle })}
          </span>
        )}
      </div>
      {total === 0 ? (
        <p className="hint">{t("No steps")}</p>
      ) : (
        part.groups.map((group) => (
          <div key={group.key}>
            <h4 className="hint" style={{ margin: "10px 0 4px" }}>
              {group.label}
            </h4>
            {group.repeat ? (
              group.items.map((item) => (
                <div key={item.key} style={{ marginTop: 6 }}>
                  <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
                    <span className="truncate" style={{ fontWeight: 600 }}>
                      {item.label}
                    </span>
                    {item.fields.map((field) => (
                      <span key={field.key} className="hint">
                        {t("{label}: {value}", {
                          label: field.label,
                          value: field.value,
                        })}
                      </span>
                    ))}
                  </div>
                  <div className="workorder-steps">
                    {item.steps.map((step) => (
                      <StepRow
                        key={step.path}
                        step={step}
                        canCheck={part.canCheck}
                        onCheck={check}
                      />
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className="workorder-steps">
                {group.items
                  .flatMap((item) => item.steps)
                  .map((step) => (
                    <StepRow
                      key={step.path}
                      step={step}
                      canCheck={part.canCheck}
                      onCheck={check}
                    />
                  ))}
              </div>
            )}
          </div>
        ))
      )}
    </section>
  );
}

/**
 * The administrator's control to turn a workorder terminal. The store writes
 * the state and moves the Master's root; nothing here picks a successor's uid,
 * because `replaced` is a state a later concern completes.
 */
function CloseControl({
  state,
  openSteps,
  onClose,
}: {
  state: WorkorderState;
  openSteps: number;
  onClose: (state: WorkorderState) => void;
}) {
  // A completed workorder is not made over an unfinished checklist: the server
  // refuses it on the effect as well, so this disable is the surface of the one
  // rule rather than the rule. Finish reads: done, skipped or not-applicable.
  const blocked = t(
    "Finish the open steps, or set them skipped with a reason, before completing.",
  );
  return (
    <section className="card">
      <div className="card-head">
        <h3>{t("Close workorder")}</h3>
      </div>
      {state === "running" ? (
        <>
          <div className="row">
            {(["completed", "cancelled", "replaced"] as const).map((next) => {
              const disallowed = next === "completed" && openSteps > 0;
              return (
                <button
                  key={next}
                  type="button"
                  className="btn btn-sm"
                  disabled={disallowed}
                  title={disallowed ? blocked : undefined}
                  onClick={() => onClose(next)}
                >
                  {t(STATE_LABELS[next])}
                </button>
              );
            })}
          </div>
          {openSteps > 0 && <p className="hint">{blocked}</p>}
        </>
      ) : (
        <button type="button" className="btn btn-sm" onClick={() => onClose("running")}>
          {t("Reopen")}
        </button>
      )}
      <p className="hint" style={{ marginBottom: 0 }}>
        {t("A closed workorder is kept for ever.")}
      </p>
    </section>
  );
}

/** One item the form names for a repeated section, before it is submitted. */
interface ItemDraft {
  /** A local identity, so a row keeps its place while its key is typed. */
  id: string;
  key: string;
  data: Record<string, string>;
}

/**
 * The administrator's creation form: a friendly name, a KB template and the
 * template's own choices. The parts follow the template — the groups its
 * sections are assigned to, and the global checklist for the rest (ADR 0030).
 *
 * A template is offered only when it has a revision in force (ADR 0028): a
 * checklist is the operational instance of a revision, and one that was never
 * approved -- or whose first is still pending -- has nothing to bind. The KB
 * may not have been read in this session at all, so the form asks for it when
 * it appears rather than making a visit to /kb a precondition.
 *
 * The template's **rules** name what the workorder must choose (ADR 0030): one
 * value per variant, and one or more items per repeated section, each with its
 * optional data fields. The rules are not on the listing, only on the revision
 * the template binds to, so the revision is read when a template is chosen and
 * the choices are drawn from it.
 */
function NewWorkorderForm({ onClose }: { onClose: () => void }) {
  const create = useWorkorders((s) => s.create);
  const [name, setName] = useState("");
  const [templateIdx, setTemplateIdx] = useState("");
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [knowledgeLoaded, setKnowledgeLoaded] = useState(false);
  const [checklist, setChecklist] = useState<KnowledgeChecklist | null>(null);
  const [checklistReady, setChecklistReady] = useState(false);
  const [variants, setVariants] = useState<Record<string, string>>({});
  const [items, setItems] = useState<Record<string, ItemDraft[]>>({});

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
              // Only a checklist template instantiates a workorder: a page
              // whose body holds checklist steps and no other (ADR 0028).
              if (a.template !== "checklist") return [];
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
                  scope: tier.scope,
                  accountId: tier.accountId,
                  id: a.id,
                  revision: issued.revision,
                  title: a.title,
                  folder: a.folder,
                  nodeId: a.nodeId,
                  parentId: a.parentId,
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

  // Choosing a template reads its revision in force for the rules the choices
  // are drawn from; a change of template starts the choices over.
  useEffect(() => {
    setVariants({});
    setItems({});
    setChecklist(null);
    setChecklistReady(false);
    if (!chosen) return;
    let alive = true;
    void (async () => {
      try {
        const { companyArticle, readArticle } = await import("@/lib/knowledge");
        const view =
          chosen.scope === "company"
            ? await companyArticle(chosen.folder)
            : await readArticle(
                chosen.accountId,
                chosen.nodeId,
                chosen.nodeId,
                chosen.folder,
                "group",
                chosen.parentId,
              );
        if (alive) setChecklist(view?.effective?.checklist ?? null);
      } catch {
        if (alive) setChecklist(null);
      } finally {
        if (alive) setChecklistReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [chosen]);

  /** Replace one repeated section's draft item rows. */
  function updateItems(sectionKey: string, update: (rows: ItemDraft[]) => ItemDraft[]) {
    setItems((prev) => ({
      ...prev,
      [sectionKey]: update(prev[sectionKey] ?? []),
    }));
  }

  const variantsChosen =
    checklist?.variants.every((v) => Boolean(variants[v.key])) ?? false;
  const itemsNamed =
    checklist?.sections
      .filter((section) => section.repeat)
      .every((section) => (items[section.key] ?? []).some((row) => row.key.trim())) ??
    false;
  const ready = Boolean(
    name.trim() && chosen && checklist && checklistReady && variantsChosen && itemsNamed,
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || !chosen || !checklist) return;
    const chosenVariants: Record<string, string> = {};
    for (const variant of checklist.variants)
      chosenVariants[variant.key] = variants[variant.key] ?? "";
    const chosenItems: Record<string, WorkorderItemInput[]> = {};
    for (const section of checklist.sections) {
      if (!section.repeat) continue;
      chosenItems[section.key] = (items[section.key] ?? [])
        .filter((row) => row.key.trim())
        .map((row) => ({ key: row.key.trim(), data: row.data }));
    }
    const input: WorkorderCreateInput = {
      name: name.trim(),
      template: {
        accountId: chosen.accountId,
        id: chosen.id,
        revision: chosen.revision,
      },
      variants: chosenVariants,
      items: chosenItems,
    };
    void create(input);
    setName("");
    setTemplateIdx("");
    onClose();
  };

  return (
    <form
      className="workorder-panel"
      role="dialog"
      aria-modal="true"
      aria-label={t("New workorder")}
      onSubmit={submit}
    >
      <div className="workorder-head">
        <h2 className="grow truncate">{t("New workorder")}</h2>
        <button
          type="button"
          className="icon-btn sm"
          aria-label={t("Close")}
          title={t("Close")}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <div className="workorder-scroll">
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

        {chosen && checklist && checklist.variants.length > 0 && (
          <div className="field">
            <label>{t("Values")}</label>
            {checklist.variants.map((variant) => (
              <div key={variant.key} className="row" style={{ gap: 8 }}>
                <span className="truncate" style={{ minWidth: 90 }}>
                  {variant.label}
                </span>
                <select
                  className="select grow"
                  value={variants[variant.key] ?? ""}
                  onChange={(e) =>
                    setVariants((prev) => ({ ...prev, [variant.key]: e.target.value }))
                  }
                >
                  <option value="">{t("Select…")}</option>
                  {variant.values.map((value) => (
                    <option key={value.value} value={value.value}>
                      {value.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}

        {chosen &&
          checklist?.sections
            .filter((section) => section.repeat)
            .map((section) => {
              const repeat = section.repeat as KnowledgeRepeat;
              return (
                <div key={section.key} className="field">
                  <label>{section.label}</label>
                  <span className="hint">
                    {t("One per {item}", { item: repeat.item })}
                  </span>
                  {(items[section.key] ?? []).map((row, index) => (
                    <div key={row.id} className="field-row">
                      <input
                        className="input"
                        value={row.key}
                        placeholder={t("{item} key", { item: repeat.item })}
                        onChange={(e) =>
                          updateItems(section.key, (rows) =>
                            rows.map((r, i) =>
                              i === index ? { ...r, key: e.target.value } : r,
                            ),
                          )
                        }
                      />
                      {repeat.fields.map((field) => (
                        <input
                          key={field.key}
                          className="input"
                          value={row.data[field.key] ?? ""}
                          placeholder={field.label}
                          onChange={(e) =>
                            updateItems(section.key, (rows) =>
                              rows.map((r, i) =>
                                i === index
                                  ? {
                                      ...r,
                                      data: { ...r.data, [field.key]: e.target.value },
                                    }
                                  : r,
                              ),
                            )
                          }
                        />
                      ))}
                      <button
                        type="button"
                        className="icon-btn xs danger"
                        aria-label={t("Remove item")}
                        title={t("Remove item")}
                        onClick={() =>
                          updateItems(section.key, (rows) =>
                            rows.filter((_, i) => i !== index),
                          )
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn btn-sm btn-soft"
                    onClick={() =>
                      updateItems(section.key, (rows) => [
                        ...rows,
                        { id: crypto.randomUUID(), key: "", data: {} },
                      ])
                    }
                  >
                    <Plus size={14} /> {t("Add {item}", { item: repeat.item })}
                  </button>
                </div>
              );
            })}

        {chosen && checklistReady && !checklist && (
          <p className="hint">{t("The template's steps could not be read.")}</p>
        )}

        {chosen && checklistReady && (
          <p className="hint">
            {t(
              "The parts are the groups the template assigns sections to; the global checklist holds the rest.",
            )}
          </p>
        )}
        <button type="submit" className="btn btn-sm btn-primary" disabled={!ready}>
          {t("Create")}
        </button>
      </div>
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
  const check = useWorkorders((s) => s.check);
  const close = useWorkorders((s) => s.close);

  const sessionAdmin = useSession((s) => s.session?.gilbert?.isAdmin === true);
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

  // The creation dialog rides over the panel; declared before the effects so
  // the Escape handler below can read it.
  const [creating, setCreating] = useState(false);

  // A store error is shown once, where the reader already is; the panel keeps
  // the last state it had rather than blanking on a failed refresh.
  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      // Escape closes the dialog on top: the creation sheet when it is open,
      // the panel itself otherwise.
      if (creating) setCreating(false);
      else closePanel();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [closePanel, creating]);

  // It opens on Running: the live work is what a reader came for, and a
  // completed pile is one click away.
  const [filter, setFilter] = useState<WorkorderState | "all">("running");
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
          {canAdminister && (
            <button
              type="button"
              className="icon-btn sm"
              aria-label={t("New workorder")}
              title={t("New workorder")}
              onClick={() => setCreating(true)}
            >
              <Plus size={18} />
            </button>
          )}
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
                        onCheck={(scope, group, path, state, note) =>
                          void check(open.uid, scope, group, path, state, note)
                        }
                      />
                    ))}
                    {/* The references surface is being reworked; until it is,
                        it is a placeholder rather than a half-working
                        gatherer. The model itself (references by id, never
                        copies, ADR 0028) is unchanged in the documents. */}
                    <section className="card">
                      <div className="card-head">
                        <h3>{t("References")}</h3>
                      </div>
                      <p className="hint">{t("To be implemented")}</p>
                    </section>
                    {canAdminister && (
                      <CloseControl
                        state={open.state}
                        openSteps={
                          open.parts
                            .flatMap(partSteps)
                            .filter((step) => step.state === "open").length
                        }
                        onClose={(state) => void close(open.uid, state)}
                      />
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

      {creating && (
        <div
          className="workorder-overlay"
          onMouseDown={(e) => {
            // A press on the creation dialog's backdrop puts it away, leaving
            // the panel underneath where it was.
            if (e.target === e.currentTarget) setCreating(false);
          }}
        >
          <NewWorkorderForm onClose={() => setCreating(false)} />
        </div>
      )}
    </div>,
    document.body,
  );
}
