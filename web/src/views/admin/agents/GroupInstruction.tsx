/**
 * One group's instruction, edited from Administration (ADR 0038).
 *
 * Two things a group decides: **in prose** how its agent works, and **which
 * areas** that work is in. The areas are the whole of what a run may change —
 * reading is free — and every area may be declared.
 *
 * The conversation and memory are **always on** and are drawn checked and
 * disabled: every run has them (transversal areas), so a group does not choose
 * them.
 *
 * The matrix that says where a run may act keeps its conservative default (the
 * conversation, and nothing else) and is not drawn here: with the areas declared,
 * a declared area is what wakes the work.
 */
import { AREA_NAMES, type AreaName } from "@gilbert/shared/areas";
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

/** The areas as the panel edits them: the always-on ones are included. */
function withAlwaysOn(areas: readonly AreaName[]): AreaName[] {
  const next = new Set<AreaName>([...areas, ...ALWAYS_ON]);
  return [...next];
}

export function GroupInstructionPanel({ group }: { group: string }) {
  const [prose, setProse] = useState<GroupInstruction | null>(null);
  const [instruction, setInstruction] = useState("");
  const [areas, setAreas] = useState<AreaName[]>([]);
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
    setBusy(true);
    setError(null);
    try {
      await saveInstruction(group, instruction, areas, prose?.state);
      /*
       * Read the document back: a stored version this build could not read is
       * replaced by the write, and the notice that said so belongs to the state
       * before it. Holding the old read would keep claiming it.
       */
      const next = await readGroupInstruction(group);
      setProse(next);
      setInstruction(next.instruction);
      setAreas(withAlwaysOn(next.areas));
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
