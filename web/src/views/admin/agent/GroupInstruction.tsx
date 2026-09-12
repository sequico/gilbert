/**
 * The group's standing instruction: the house rules its agent carries into
 * every model call (ADR 0003 resolution 17).
 *
 * Written by an administrator of the group, and deliberately separate from the
 * automations below it: an automation says what to do about one kind of event,
 * this says how the group's agent should behave whatever it is looking at —
 * the tone, the language, the local conventions. It is handed to the model
 * first, before the automation's own instruction and before the mail it reads.
 *
 * It can steer and it cannot grant. Nothing written here widens what an
 * automation may do: that is its capability list, checked on every answer the
 * model gives, and the sentence under the field says so where a person writing
 * it can read it.
 */
import { useEffect, useState } from "react";
import { fetchGroupInstruction, saveGroupInstruction } from "@/lib/agents";
import { t } from "@/lib/i18n";

export function GroupInstruction({ groups }: { groups: readonly string[] }) {
  const [group, setGroup] = useState<string>(groups[0] ?? "");
  const [text, setText] = useState("");
  // What the record holds, beside what the field holds: the difference is the
  // only thing the save button has to say, so it is dimmed until there is one.
  const [baseline, setBaseline] = useState("");
  const [saved, setSaved] = useState<{ at: string | null; by: string | null }>({
    at: null,
    by: null,
  });
  const [max, setMax] = useState(4000);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!groups.includes(group)) setGroup(groups[0] ?? "");
  }, [groups, group]);

  useEffect(() => {
    if (!group) return;
    let live = true;
    setBusy(true);
    setProblem(null);
    setDone(false);
    void fetchGroupInstruction(group)
      .then((view) => {
        if (!live) return;
        setText(view.text);
        setBaseline(view.text);
        setMax(view.max);
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

  const save = () => {
    if (!group || busy) return;
    setBusy(true);
    setProblem(null);
    setDone(false);
    void saveGroupInstruction(group, text)
      .then((view) => {
        setText(view.text);
        setBaseline(view.text);
        setSaved({ at: view.updatedAt, by: view.updatedBy });
        setDone(true);
      })
      .catch((err) => setProblem(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <section>
      <h2>{t("Standing instruction")}</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "Written once for the whole group and handed to the model on every call, before the automation's own instruction and before the message it is looking at. It says how the agent should work; what an automation may do is its capability list, and nothing written here widens it.",
        )}
      </p>
      {groups.length === 0 ? (
        <p className="hint">
          {t(
            "The agent is not in a group this session can see. Give it a group in Stalwart's own administration first: an instruction for a group the agent does not work in would never be read.",
          )}
        </p>
      ) : (
        <>
          {/* Shown even with a single granted group: the picker is how a person
              reads which group's instruction the field below belongs to. */}
          <div className="field">
            <label htmlFor="agent-instruction-group">{t("Group")}</label>
            <select
              id="agent-instruction-group"
              className="input"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
            >
              {groups.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="agent-instruction-text">
              {t("How this group's agent works")}
            </label>
            <textarea
              id="agent-instruction-text"
              className="textarea"
              rows={10}
              value={text}
              maxLength={max}
              placeholder={t(
                "Write to the group in its own language, and always cite the invoice number.",
              )}
              onChange={(e) => {
                setText(e.target.value);
                setDone(false);
              }}
            />
            <p className="hint">
              {t("An empty text removes it. At most {max} characters.", { max })}
            </p>
          </div>
          {problem && <div className="error-box">{problem}</div>}
          {done && !problem && <p className="hint">{t("Saved.")}</p>}
          <button
            type="button"
            className="btn"
            onClick={save}
            disabled={busy || text === baseline}
          >
            {busy ? t("Saving…") : t("Save the instruction")}
          </button>
          {saved.at && (
            <p className="hint" style={{ marginTop: 8 }}>
              {t("Last written by {who} on {when}.", {
                who: saved.by ?? t("an administrator"),
                when: saved.at,
              })}
            </p>
          )}
        </>
      )}
    </section>
  );
}
