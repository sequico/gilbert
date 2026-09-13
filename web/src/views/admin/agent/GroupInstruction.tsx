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
 *
 * The group is handed in rather than picked here (ADR 0003): the Group Agents
 * workspace owns one pick for all of its tabs, and a second picker inside a
 * tab was a second answer to the same question.
 */
import { useEffect, useState } from "react";
import {
  fetchGroupInstruction,
  readDraft,
  readingNotCountedNote,
  saveGroupInstruction,
} from "@/lib/agents";
import { t } from "@/lib/i18n";

export function GroupInstruction({ group }: { group: string }) {
  const [text, setText] = useState("");
  // What the record holds, beside what the field holds: the difference is the
  // only thing the save button has to say, so it is dimmed until there is one.
  const [baseline, setBaseline] = useState("");
  const [saved, setSaved] = useState<{ at: string | null; by: string | null }>({
    at: null,
    by: null,
  });
  const [max, setMax] = useState(4000);
  // The author's remarks beside the prose: carried in the same document, read by
  // nobody's model (ADR 0003).
  const [notes, setNotes] = useState("");
  const [notesBaseline, setNotesBaseline] = useState("");
  const [notesMax, setNotesMax] = useState(2000);
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
        setNotes(view.notes);
        setNotesBaseline(view.notes);
        setMax(view.max);
        setNotesMax(view.notesMax);
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
  }, [group]);

  const save = () => {
    if (!group || busy) return;
    setBusy(true);
    setProblem(null);
    setDone(false);
    void saveGroupInstruction(group, text, notes)
      .then((view) => {
        setText(view.text);
        setBaseline(view.text);
        setNotes(view.notes);
        setNotesBaseline(view.notes);
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
    if (!group || readingBusy || !text.trim()) return;
    setReadingBusy(true);
    setReading(null);
    setReadingCounted(true);
    setProblem(null);
    void readDraft(group, text, t("the group's standing instruction"))
      .then((answer) => {
        setReading(answer.text);
        setReadingCounted(answer.counted);
      })
      .catch((err) => setReading(err instanceof Error ? err.message : String(err)))
      .finally(() => setReadingBusy(false));
  };

  return (
    <section>
      <h2>{t("Standing instruction")}</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "Written once for the whole group and handed to the model on every call, before the automation's own instruction and before the message it is looking at. It says how the agent should work; what an automation may do is its capability list, and nothing written here widens it.",
        )}
      </p>
      {!group ? (
        <p className="hint">
          {t("No group is picked, so there is no standing instruction to read here.")}
        </p>
      ) : (
        <>
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
          <div className="field">
            <label htmlFor="agent-instruction-notes">{t("Your notes beside it")}</label>
            <textarea
              id="agent-instruction-notes"
              className="textarea"
              rows={3}
              value={notes}
              maxLength={notesMax}
              placeholder={t(
                "What this instruction is for, and what it deliberately leaves out. Nobody's model reads this.",
              )}
              onChange={(e) => {
                setNotes(e.target.value);
                setDone(false);
              }}
            />
            <p className="hint">
              {t(
                "Kept with the instruction for whoever edits it next, and never sent to a model: a run carries the instruction and nothing beside it.",
              )}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={askReading}
            disabled={readingBusy || !text.trim()}
          >
            {readingBusy ? t("Reading…") : t("Ask the model to read it")}
          </button>
          {reading && (
            <div className="card" style={{ marginTop: 12 }}>
              <p className="hint" style={{ marginTop: 0 }}>
                {t("What the model said about this draft:")}
              </p>
              <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{reading}</p>
              {!readingCounted && <p className="hint">{readingNotCountedNote()}</p>}
            </div>
          )}
          {problem && <div className="error-box">{problem}</div>}
          {done && !problem && <p className="hint">{t("Saved.")}</p>}
          <button
            type="button"
            className="btn"
            onClick={save}
            disabled={busy || (text === baseline && notes === notesBaseline)}
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
