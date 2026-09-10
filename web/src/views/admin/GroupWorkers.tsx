/**
 * What the worker does in each group (ADR 0009).
 *
 * The areas an administrator narrows a group to — per group, and for as many
 * groups as they mean at once. The deployment says which areas the fleet serves
 * at all; this surface can only take work away inside that, because a product
 * decision must not widen what an operator allowed.
 *
 * Two things are deliberately not here. The **grant** is not a setting: the
 * agent's membership of a group is decided in Stalwart's own administration,
 * and this surface reads it and says so. And the change reaches the **worker**
 * when it starts, not the moment it is saved — the web tier reads the record
 * live, the worker reads it at boot, and the surface says which is which.
 */
import { AGENT_AREAS } from "@gilbert/agent/documents";
import { useEffect, useState } from "react";
import { saveAgentGroupAreas } from "@/lib/agents";
import { t } from "@/lib/i18n";
import { useAgents } from "@/store/agents";
import { areaText } from "@/views/agent/agentText";

export function GroupWorkers() {
  const status = useAgents((s) => s.status);
  const loadStatus = useAgents((s) => s.loadStatus);

  // What each group is narrowed to, as an editor's draft: the record is what
  // the status answers, this is what an administrator is changing, and saving
  // is what makes them agree.
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const groups = status?.groups ?? [];
  const deployment = status?.defaultAreas ?? [...AGENT_AREAS];
  const configured = (name: string): string[] =>
    groups.find((group) => group.name === name)?.areas ?? deployment;
  /** The draft of one group: its own narrowing, or everything the deployment serves. */
  const draftOf = (name: string): string[] => drafts[name] ?? configured(name);
  const touched = Object.keys(drafts);

  function edit(name: string, areas: string[]) {
    setDrafts((current) => ({ ...current, [name]: areas }));
    setSaved(false);
  }

  function toggleArea(name: string, area: string, on: boolean) {
    const current = draftOf(name);
    edit(name, on ? [...current, area] : current.filter((one) => one !== area));
  }

  function toggleSelected(name: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  /** Give every selected group the areas in the bulk bar, in one gesture. */
  function applyBulk() {
    if (!selected.size) return;
    setDrafts((current) => {
      const next = { ...current };
      for (const name of selected) next[name] = [...bulk];
      return next;
    });
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setProblem(null);
    setSaved(false);
    try {
      // Only the groups somebody touched travel: a group nobody changed is not
      // a decision, and naming it would write one anyway.
      await saveAgentGroupAreas(
        Object.fromEntries(touched.map((name) => [name, drafts[name] ?? []])),
      );
      setDrafts({});
      setSaved(true);
      await loadStatus();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2>{t("Group workers")}</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "What the agent works on inside each group: the areas below are the fleet's reach here, and the deployment serves them all unless a group is narrowed. Nothing here grants anything — membership of the agent is granted in Stalwart's own administration, beside the accounts.",
        )}
      </p>
      {status?.enumeration === false && (
        <div className="warn-box" style={{ marginBottom: 12 }}>
          {t(
            "The group mailboxes could not all be listed, so this page covers only the groups you are a member of: a group that is missing here may still be served.",
          )}
          {status.enumerationMessage && (
            <>
              {" "}
              <code>{status.enumerationMessage}</code>
            </>
          )}
        </div>
      )}
      {!status ? (
        <p className="hint">{t("Loading…")}</p>
      ) : !status.address ? (
        <div className="warn-box">
          {t(
            "No agent is registered with this installation yet, so there is nothing for a group to be narrowed for. Name its address in the Agents section first.",
          )}
        </div>
      ) : groups.length === 0 ? (
        <p className="hint">{t("No group mailbox is visible to this session.")}</p>
      ) : (
        <>
          <div className="row wrap" style={{ gap: 12, marginBottom: 12 }}>
            <button
              className="btn"
              type="button"
              onClick={() => setSelected(new Set(groups.map((group) => group.name)))}
            >
              {t("Select all")}
            </button>
            <button className="btn" type="button" onClick={() => setSelected(new Set())}>
              {t("Select none")}
            </button>
            <span className="hint">{t("{n} selected", { n: selected.size })}</span>
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-head">
              <h3>{t("Give the selected groups these areas")}</h3>
            </div>
            <div className="row wrap" style={{ gap: 12, marginBottom: 8 }}>
              {AGENT_AREAS.map((area) => (
                <label key={area} className="row" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={bulk.includes(area)}
                    onChange={(event) => {
                      setBulk((current) =>
                        event.target.checked
                          ? [...current, area]
                          : current.filter((one) => one !== area),
                      );
                      setSaved(false);
                    }}
                  />
                  {areaText(area)}
                </label>
              ))}
            </div>
            <button
              className="btn"
              type="button"
              disabled={!selected.size}
              onClick={applyBulk}
            >
              {selected.size
                ? t("Apply to {n} selected group(s)", { n: selected.size })
                : t("Select groups first")}
            </button>
            <p className="hint" style={{ marginTop: 8 }}>
              {t(
                'An empty selection of areas means the group is served as the deployment says; it never means "do nothing here".',
              )}
            </p>
          </div>

          <table className="sessions-table">
            <thead>
              <tr>
                <th />
                <th>{t("Group")}</th>
                <th>{t("Agent")}</th>
                <th>{t("Areas the worker serves here")}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.name}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={group.name}
                      checked={selected.has(group.name)}
                      onChange={(event) =>
                        toggleSelected(group.name, event.target.checked)
                      }
                    />
                  </td>
                  <td className="notranslate" translate="no">
                    {group.name}
                  </td>
                  <td>
                    {group.granted ? (
                      <span className="agent-state ok">{t("Granted")}</span>
                    ) : (
                      <span className="agent-state off">{t("Not granted")}</span>
                    )}
                  </td>
                  <td>
                    <div className="row wrap" style={{ gap: 10 }}>
                      {AGENT_AREAS.map((area) => (
                        <label key={area} className="row" style={{ gap: 4 }}>
                          <input
                            type="checkbox"
                            checked={draftOf(group.name).includes(area)}
                            onChange={(event) =>
                              toggleArea(group.name, area, event.target.checked)
                            }
                          />
                          {areaText(area)}
                          {!deployment.includes(area) && (
                            <span className="hint">{t("(not served here)")}</span>
                          )}
                        </label>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="row wrap" style={{ gap: 12, marginTop: 12 }}>
            <button
              className="btn btn-primary"
              type="button"
              disabled={saving || touched.length === 0}
              onClick={() => void save()}
            >
              {saving
                ? t("Saving…")
                : touched.length
                  ? t("Save {n} changed group(s)", { n: touched.length })
                  : t("Nothing changed")}
            </button>
            {touched.length > 0 && (
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setDrafts({});
                  setSaved(false);
                }}
              >
                {t("Discard changes")}
              </button>
            )}
            {saved && <span className="hint">{t("Saved.")}</span>}
          </div>
          {problem && (
            <div className="error-box" style={{ marginTop: 12 }}>
              {problem}
            </div>
          )}
          <p className="hint" style={{ marginTop: 12 }}>
            {t(
              "The worker reads this record when it starts, so a change reaches automations at the next restart of the worker; this surface reads it immediately.",
            )}
          </p>
        </>
      )}
    </section>
  );
}
