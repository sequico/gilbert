/**
 * One group's instruction, edited from Administration (ADR 0038).
 *
 * Three things a group decides: **in prose** how its agent works, **which
 * areas** that work may change — reading is free — and **what wakes it**. The
 * areas are the whole of what a run may write, and every area may be declared;
 * the wake row is the whole of what opens a run, and chat is always on.
 *
 * The conversation and memory are **always on** as areas and are drawn checked
 * and disabled: every run has them (transversal areas, the one definition both tiers
 * read), so a group does not choose them. Knowledge is **not** among them: a group
 * that ticks it lets its agent propose pages, and a group that does not leaves the
 * base readable and unchanged by the agent. The wake row draws **the same areas in
 * the same order**, one
 * surface each: chat checked and dimmed (the conversation is where the group
 * calls the agent), and memory and contacts unchecked and dimmed, because no
 * change on either is a surface that can wake a run.
 */
import {
  AREA_NAMES,
  type AreaName,
  surfaceOfArea,
  TRANSVERSAL_AREAS,
} from "@gilbert/shared/areas";
import { errorMessage } from "@gilbert/shared/errors";
import type { SurfaceMatrix, SurfaceName } from "@gilbert/shared/surfaces";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/jmap/client";
import {
  type GroupInstruction,
  readGroupInstruction,
  saveInstruction,
} from "@/lib/agentInstruction";
import { t } from "@/lib/i18n";

/** The word an area goes by, translated where it is drawn. */
const AREA_LABEL: Record<AreaName, string> = {
  mail: "Mail",
  files: "Files",
  calendar: "Calendar",
  contacts: "Contacts",
  knowledge: "Knowledge",
  workorders: "Workorders",
  chat: "Chat",
  memory: "Memory",
};

/** The areas as the panel edits them: the always-on ones are included. */
function withAlwaysOn(areas: readonly AreaName[]): AreaName[] {
  const next = new Set<AreaName>([...areas, ...TRANSVERSAL_AREAS]);
  return [...next];
}

export function GroupInstructionPanel({ group }: { group: string }) {
  const [prose, setProse] = useState<GroupInstruction | null>(null);
  const [instruction, setInstruction] = useState("");
  const [report, setReport] = useState("");
  const [areas, setAreas] = useState<AreaName[]>([]);
  const [surfaces, setSurfaces] = useState<SurfaceMatrix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    setProse(null);
    try {
      const next = await readGroupInstruction(id);
      setProse(next);
      setInstruction(next.instruction);
      setReport(next.report ?? "");
      setAreas(withAlwaysOn(next.areas));
      setSurfaces(next.surfaces);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(group);
  }, [group, load]);

  const save = async () => {
    if (!surfaces) return;
    setBusy(true);
    setError(null);
    try {
      await saveInstruction(group, instruction, areas, surfaces, report, prose?.state);
      /*
       * Read the document back: a stored version this build could not read is
       * replaced by the write, and the notice that said so belongs to the state
       * before it. Holding the old read would keep claiming it.
       */
      const next = await readGroupInstruction(group);
      setProse(next);
      setInstruction(next.instruction);
      setReport(next.report ?? "");
      setAreas(withAlwaysOn(next.areas));
      setSurfaces(next.surfaces);
      setSaved(true);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409)) {
        setError(errorMessage(err));
      } else {
        await load(group);
        setError(
          t(
            "Somebody else changed this group's prose. The list has been reloaded, and your edit was not saved.",
          ),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const toggle = (area: AreaName) => {
    if (TRANSVERSAL_AREAS.includes(area)) return;
    setSaved(false);
    setAreas((held) =>
      held.includes(area) ? held.filter((one) => one !== area) : [...held, area],
    );
  };

  const toggleWake = (surface: SurfaceName) => {
    if (surface === "chat") return;
    setSaved(false);
    setSurfaces((held) => {
      if (!held) return held;
      const mode = held[surface] === "watch" ? "off" : "watch";
      return { ...held, [surface]: mode } as SurfaceMatrix;
    });
  };

  /*
   * The always-on areas are drawn after the ones a group chooses, the
   * conversation last, and a group may declare every other area it works.
   */
  const chosen = areas.filter((one) => !TRANSVERSAL_AREAS.includes(one));
  const listed = [
    ...AREA_NAMES.filter((one) => !TRANSVERSAL_AREAS.includes(one)),
    ...TRANSVERSAL_AREAS,
  ];

  return (
    <div>
      <h2>{t("Instruction")}</h2>
      <p className="hint">
        {t("How the group wants its agent to work, on every call it makes.")}
      </p>
      {error && <div className="error-box">{error}</div>}{" "}
      {prose?.unreadable && (
        <div className="error-box">
          {t(
            "This group's instruction cannot be read by this build. Writing a new one replaces it.",
          )}
          <div className="hint">{prose.unreadable}</div>
        </div>
      )}
      {busy && !prose && <p className="hint">{t("Loading…")}</p>}
      {prose && (
        <>
          <div className="field">
            <label htmlFor="group-instruction">{t("Standing instruction")}</label>
            <textarea
              id="group-instruction"
              rows={4}
              value={instruction}
              onChange={(e) => {
                setInstruction(e.target.value);
                setSaved(false);
              }}
            />
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="group-report">{t("The shape of a report")}</label>
            <p className="hint">
              {t(
                "How a report of this group's work reads, when the group wants one: what it names and in what order. Declaring one has every report judged against it.",
              )}
            </p>
            <textarea
              id="group-report"
              rows={3}
              value={report}
              onChange={(e) => {
                setReport(e.target.value);
                setSaved(false);
              }}
            />
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label>{t("Areas")}</label>
            <p className="hint">
              {t("What the group's agent may change. Reading is always allowed.")}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              {listed.map((area) => {
                const always = TRANSVERSAL_AREAS.includes(area);
                const why =
                  area === "memory"
                    ? t("AI Agents can always write memory")
                    : area === "chat"
                      ? t("AI Agents can always write on their chat")
                      : undefined;
                return (
                  <label
                    key={area}
                    title={always ? why : undefined}
                    style={{
                      display: "flex",
                      gap: 6,
                      alignItems: "center",
                      opacity: always ? 0.6 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={always || areas.includes(area)}
                      disabled={always}
                      onChange={() => toggle(area)}
                    />
                    {t(AREA_LABEL[area])}
                  </label>
                );
              })}
            </div>
            {chosen.length === 0 && (
              <p className="hint">
                {t(
                  "No other area is ticked: the agent works only the conversation and memory.",
                )}
              </p>
            )}
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label>{t("What wakes the agent")}</label>
            <p className="hint">
              {t(
                "Changes on a ticked surface are brought to the agent automatically; ticking an area above does not wake it on its own.",
              )}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              {listed.map((area) => {
                /*
                 * One row per area, in the areas row's own order: the wake row is
                 * that list read as surfaces, not a second list to reconcile.
                 * Chat is the one surface always watched; memory and contacts have
                 * no surface at all, so they are drawn unchecked and say why.
                 */
                const surface = surfaceOfArea(area);
                const always = area === "chat";
                const cannotWake = surface === null;
                const watched =
                  always || (surface !== null && surfaces?.[surface] === "watch");
                const why = always
                  ? t("AI Agents are always awaken by chat messages")
                  : area === "memory"
                    ? t("AI Agents cannot be awaken by memory changes")
                    : cannotWake
                      ? t("AI Agents cannot be awaken by contacts changes")
                      : undefined;
                return (
                  <label
                    key={area}
                    title={always || cannotWake ? why : undefined}
                    style={{
                      display: "flex",
                      gap: 6,
                      alignItems: "center",
                      opacity: always || cannotWake ? 0.6 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={watched}
                      disabled={always || cannotWake || busy}
                      onChange={() => {
                        if (surface) toggleWake(surface);
                      }}
                    />
                    {t(AREA_LABEL[area])}
                  </label>
                );
              })}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={save}
            >
              {t("Save")}
            </button>
            {saved && <span className="hint">{t("Saved")}</span>}
          </div>
        </>
      )}
    </div>
  );
}
