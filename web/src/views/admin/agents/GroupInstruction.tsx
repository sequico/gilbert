/**
 * One group's instruction, edited from Administration (ADR 0038).
 *
 * Two things a group decides: **in prose** how its agent works, and **which
 * areas** that work is in. The areas are the whole of what a run may change —
 * reading is free — so the list is capped by the server at three, and a group
 * that needs more writes two instructions' worth of work as two groups.
 *
 * The matrix that says where a run may act keeps its conservative default (the
 * conversation, and nothing else) and is not drawn here: with the areas declared,
 * a declared area is what wakes the work.
 */
import { AREA_NAMES, type AreaName, MAX_DECLARED_AREAS } from "@gilbert/shared/areas";
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
      setAreas(next.areas);
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
    setSaved(false);
    setAreas((held) =>
      held.includes(area) ? held.filter((one) => one !== area) : [...held, area],
    );
  };

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
              {AREA_NAMES.map((area) => (
                <label
                  key={area}
                  style={{ display: "flex", gap: 6, alignItems: "center" }}
                >
                  <input
                    type="checkbox"
                    checked={areas.includes(area)}
                    disabled={!areas.includes(area) && areas.length >= MAX_DECLARED_AREAS}
                    onChange={() => toggle(area)}
                  />
                  {t(AREA_LABEL[area])}
                </label>
              ))}
            </div>
            {areas.length === 0 && (
              <p className="hint">
                {t("No area is ticked: the agent works only the conversation.")}
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
