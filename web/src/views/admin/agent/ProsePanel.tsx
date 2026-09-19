/**
 * One document of prose an agent carries (ADR 0003, ADR 0019).
 *
 * The three levels of prose an automation runs under are the same thing at
 * three reaches, and two of them are documents a person writes in a form:
 *
 * - the **installation's own rules**, in the Master's account, written once for
 *   every group this installation serves;
 * - a **group's standing instruction**, in the group's own account, written for
 *   that group;
 *
 * (the third — an automation's instruction — is authored in the automation
 * itself, beside the trigger it belongs to). They differ in where they are
 * stored and in how far they reach, never in shape, so they are one component
 * with the scope handed in.
 *
 * Both can steer and neither can grant: what an automation may do is its own
 * capability list, checked on every answer the model gives, so nothing written
 * here widens it. That sentence is on the screen where a person is writing it.
 *
 * The scope is a group name for a group's instruction and the empty string for
 * the installation's own rules, which is also the scope the API takes: the two
 * reach different routes, and the difference belongs there rather than here.
 */
import { useEffect, useState } from "react";
import { fetchAgentProse, readDraft, saveAgentProse } from "@/lib/agents";
import { t } from "@/lib/i18n";
import { proseStampText } from "@/views/agent/agentText";
import { AskReading } from "./AskReading";

export function ProsePanel({
  scope,
  heading,
  lead,
  label,
  placeholder,
  readingAbout,
  /** False where the panel is the installation's own and there is no group. */
  canRead = true,
}: {
  /** A group's name, or "" for the installation's own rules. */
  scope: string;
  heading: string;
  lead: string;
  label: string;
  placeholder: string;
  /** What a reading says it is about, in the author's language. */
  readingAbout: string;
  canRead?: boolean;
}) {
  const [text, setText] = useState("");
  // What the record holds, beside what the field holds: the difference is the
  // only thing the save button has to say, so it is dimmed until there is one.
  const [baseline, setBaseline] = useState("");
  const [saved, setSaved] = useState<{ at: string | null; by: string | null }>({
    at: null,
    by: null,
  });
  const [max, setMax] = useState(4000);
  // The reading: what the model answered about this draft, or the refusal in
  // the reader's language. Neither is stored, so neither outlives the panel.
  const [reading, setReading] = useState<string | null>(null);
  /*
   * Whether the answer on screen reached the month's authoring document, set
   * from the answer and reset with each ask: a refusal has no count to be
   * missing, so the note stays away from one.
   */
  const [readingCounted, setReadingCounted] = useState(true);
  const [readingBusy, setReadingBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let live = true;
    setBusy(true);
    setProblem(null);
    setDone(false);
    void fetchAgentProse(scope)
      .then((view) => {
        if (!live) return;
        setText(view.text);
        setBaseline(view.text);
        setMax(view.max);
        setReading(null);
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
  }, [scope]);

  const save = () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setDone(false);
    void saveAgentProse(scope, text)
      .then((view) => {
        setText(view.text);
        setBaseline(view.text);
        setSaved({ at: view.updatedAt, by: view.updatedBy });
        setDone(true);
      })
      .catch((err) => setProblem(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  /**
   * Ask the installation's model to read this draft (ADR 0003). Nothing is
   * saved: the answer is shown beside the field it is about and forgotten when
   * the panel closes, which is what an author's reading is.
   */
  const askReading = () => {
    if (!canRead || readingBusy || !text.trim()) return;
    setReadingBusy(true);
    setReading(null);
    setReadingCounted(true);
    setProblem(null);
    void readDraft(scope, text, readingAbout)
      .then((answer) => {
        setReading(answer.text);
        setReadingCounted(answer.counted);
      })
      .catch((err) => setReading(err instanceof Error ? err.message : String(err)))
      .finally(() => setReadingBusy(false));
  };

  return (
    <section>
      <h2>{heading}</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        {lead}
      </p>
      <div className="field">
        <label htmlFor={`agent-prose-${scope || "installation"}`}>{label}</label>
        <textarea
          id={`agent-prose-${scope || "installation"}`}
          className="textarea"
          rows={10}
          value={text}
          maxLength={max}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setDone(false);
          }}
        />
        <p className="hint">
          {text.trim()
            ? t("An empty text removes it. At most {max} characters.", { max })
            : t("At most {max} characters.", { max })}
        </p>
      </div>
      <AskReading
        ready={canRead && text.trim().length > 0}
        busy={readingBusy}
        reading={reading}
        counted={readingCounted}
        onAsk={askReading}
      />
      {problem && <div className="error-box">{problem}</div>}
      {done && !problem && <p className="hint">{t("Saved.")}</p>}
      <button
        type="button"
        className="btn"
        onClick={save}
        disabled={busy || text === baseline}
      >
        {busy ? t("Saving…") : t("Save")}
      </button>
      <p className="hint" style={{ marginTop: 8 }}>
        {proseStampText({ updatedAt: saved.at, updatedBy: saved.by })}
      </p>
    </section>
  );
}
