/**
 * One group's instruction, edited from Administration (ADR 0038).
 *
 * Three things a group decides: **in prose** how its agent works, **which
 * areas** that work may change — reading is free — and **what wakes it**. The
 * areas are the whole of what a run may write, and every area may be declared;
 * the wake row is the whole of what opens a run, and chat is always on.
 *
 * The conversation and memory are **always on** as areas and are drawn checked
 * and disabled: every run has them (transversal areas), so a group does not
 * choose them. Chat is also always on in the wake row, drawn checked and dimmed:
 * the conversation is where the group calls the agent.
 */
import { AREA_NAMES, type AreaName } from "@gilbert/shared/areas";
import { SURFACES, type SurfaceMatrix, type SurfaceName } from "@gilbert/shared/surfaces";
import { errorMessage } from "@gilbert/shared/errors";
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

/** The areas every run has, drawn checked and disabled: they are not a choice. */
const ALWAYS_ON: readonly AreaName[] = ["memory", "chat"];

/** The surface labels, translated where they are drawn. */
const SURFACE_LABEL: Record<SurfaceName, string> = {
  chat: "Chat",
  mail: "Mail",
  files: "Files",
  knowledge: "Knowledge",
  workorder: "Workorders",
  calendar: "Calendar",
};

/** The surfaces in the wake row: the conversation is always last and always on. */
const WAKE_ORDER: readonly SurfaceName[] = [
  ...SURFACES.filter((one) => one !== "chat"),
  "chat",
];

/** The areas as the panel edits them: the always-on ones are included. */
function withAlwaysOn(areas: readonly AreaName[]): AreaName[] {
  const next = new Set<AreaName>([...areas, ...ALWAYS_ON]);
  return [...next];
}

export function GroupInstructionPanel({ group }: { group: string }) {
  const [prose, setProse] = useState<GroupInstruction | null>(null);
  const [instruction, setInstruction] = useState("");
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
      await saveInstruction(group, instruction, areas, surfaces, prose?.state);
      /*
       * Read the document back: a stored version this build could not read is
       * replaced by the write, and the notice that said so belongs to the state
       * before it. Holding the old read would keep claiming it.
       */
      const next = await readGroupInstruction(group);
      setProse(next);
      setInstruction(next.instruction);
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
    if (ALWAYS_ON.includes(area)) return;
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
  const chosen = areas.filter((one) => !ALWAYS_ON.includes(one));
  const listed = [...AREA_NAMES.filter((one) => !ALWAYS_ON.includes(one)), ...ALWAYS_ON];

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
            <label>{t("Areas")}</label>
            <p className="hint">
              {t("What the group's agent may change. Reading is always allowed.")}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              {listed.map((area) => {
                const always = ALWAYS_ON.includes(area);
                return (
                  <label
                    key={area}
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
              {WAKE_ORDER.map((surface) => {
                const always = surface === "chat";
                const watched = always || surfaces?.[surface] === "watch";
                return (
                  <label
                    key={surface}
                    style={{
                      display: "flex",
                      gap: 6,
                      alignItems: "center",
                      opacity: always ? 0.6 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={watched}
                      disabled={always || busy}
                      onChange={() => toggleWake(surface)}
                    />
                    {t(SURFACE_LABEL[surface])}
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
