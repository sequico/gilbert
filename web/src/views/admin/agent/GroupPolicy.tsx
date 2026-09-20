/**
 * A group's policy: who its runs stop for, and whether they may reach outside
 * the group without a person (ADR 0006).
 *
 * It is one document per group rather than a field on every automation. The
 * question it answers — how cautious this group wants its agent to be — is a
 * fact about the group: two automations of one group are the same team's work
 * on the same correspondence, and a policy repeated per automation is a policy
 * that drifts apart. The grant of *what* an automation may do stays on the
 * automation; this is only what happens before it does it.
 *
 * Two choices and no number. "Ask a person below a confidence threshold" is the
 * behaviour an author picks, not a decimal, so the threshold is one constant
 * (`AGENT_REVIEW_THRESHOLD`) rather than a field every author had to invent.
 *
 * Neither choice can lower a floor that is in code: an action that cannot be
 * undone asks whatever is chosen here, and one that reaches outside the group
 * asks unless the group has raised that floor on purpose — which is what the
 * second switch is.
 *
 * The group is handed in rather than picked here: the Group Agents workspace
 * owns one pick for all of its tabs.
 */
import type { AgentReviewMode } from "@gilbert/agent/documents";
import { AGENT_REVIEW_MODES } from "@gilbert/agent/documents";
import { useEffect, useState } from "react";
import { fetchGroupPolicy, saveGroupPolicy } from "@/lib/agents";
import { t } from "@/lib/i18n";
import {
  AGENT_REVIEW_LABELS,
  AGENT_REVIEW_MEANING_LABELS,
  proseStampText,
} from "@/views/agent/agentText";

export function GroupPolicy({ group }: { group: string }) {
  const [review, setReview] = useState<AgentReviewMode>("always");
  const [allowExternal, setAllowExternal] = useState(false);
  const [present, setPresent] = useState(false);
  const [baseline, setBaseline] = useState<{
    review: AgentReviewMode;
    allowExternal: boolean;
  }>({ review: "always", allowExternal: false });
  const [saved, setSaved] = useState<{ at: string | null; by: string | null }>({
    at: null,
    by: null,
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!group) return;
    let live = true;
    setBusy(true);
    setProblem(null);
    setDone(false);
    void fetchGroupPolicy(group)
      .then((view) => {
        if (!live) return;
        setReview(view.review);
        setAllowExternal(view.allowExternal);
        setPresent(view.present);
        setBaseline({ review: view.review, allowExternal: view.allowExternal });
        setSaved({ at: view.updatedAt, by: view.updatedBy });
      })
      .catch((err) => {
        if (live) setProblem(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [group]);

  const changed = review !== baseline.review || allowExternal !== baseline.allowExternal;

  const save = () => {
    if (!group || busy) return;
    setBusy(true);
    setProblem(null);
    setDone(false);
    void saveGroupPolicy(group, { review, allowExternal })
      .then((view) => {
        setReview(view.review);
        setAllowExternal(view.allowExternal);
        setPresent(true);
        setBaseline({ review: view.review, allowExternal: view.allowExternal });
        setSaved({ at: view.updatedAt, by: view.updatedBy });
        setDone(true);
      })
      .catch((err) => setProblem(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <section>
      <h2>{t("Review")}</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "Who this group's runs stop for, and whether they may reach outside the group without a person. One policy for the whole group: its automations are the same team's work on the same correspondence.",
        )}
      </p>
      {!group ? (
        <p className="hint">
          {t("No group is picked, so there is no policy to read here.")}
        </p>
      ) : (
        <>
          {!present && (
            <p className="hint" style={{ marginBottom: 12 }}>
              {t(
                "This group has not written a policy, so a run goes ahead when the model is confident and stops for a person when it is not. An action that leaves the group or cannot be undone always asks.",
              )}
            </p>
          )}
          <div className="field" style={{ maxWidth: 420 }}>
            <label htmlFor="agent-group-review">{t("When a person has to agree")}</label>
            <select
              id="agent-group-review"
              className="select"
              value={review}
              onChange={(e) => {
                const mode = e.target.value as AgentReviewMode;
                if ((AGENT_REVIEW_MODES as ReadonlyArray<string>).includes(mode)) {
                  setReview(mode);
                  setDone(false);
                }
              }}
            >
              {AGENT_REVIEW_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(AGENT_REVIEW_LABELS[mode])}
                </option>
              ))}
            </select>
            <p className="hint">{t(AGENT_REVIEW_MEANING_LABELS[review])}</p>
          </div>
          <label className="agent-check">
            <input
              type="checkbox"
              checked={allowExternal}
              onChange={(e) => {
                setAllowExternal(e.target.checked);
                setDone(false);
              }}
            />
            <span>
              {t(
                "Allow sending outside the group without a person — this raises the external-send consent floor.",
              )}
            </span>
          </label>
          <p className="hint">
            {t(
              "Off, an action that reaches outside the group always waits for a person, whatever the policy says. An action that cannot be undone asks whatever either setting says.",
            )}
          </p>
          {problem && <div className="error-box">{problem}</div>}
          {done && !problem && <p className="hint">{t("Saved.")}</p>}
          <button
            type="button"
            className="btn"
            onClick={save}
            disabled={busy || !changed}
          >
            {busy ? t("Saving…") : t("Save")}
          </button>
          <p className="hint" style={{ marginTop: 8 }}>
            {proseStampText({ updatedAt: saved.at, updatedBy: saved.by })}
          </p>
        </>
      )}
    </section>
  );
}
