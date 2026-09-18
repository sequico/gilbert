import { readingNotCountedNote } from "@/lib/agents";
import { t } from "@/lib/i18n";

/**
 * The "ask the model to read it" card.
 *
 * Both surfaces that edit an automation's prose offer it — the group's standing
 * instruction and one rule's instruction — and both draw the same thing: a
 * ghost button that goes to "Reading…" while the model answers, and the answer
 * in a card of its own.
 *
 * What differs is only when there is something worth asking about, which is the
 * caller's business: the standing instruction needs its text, a rule needs the
 * group and the rule's own instruction. So the caller says whether the draft is
 * ready and this decides that a busy or unready button is a dead one.
 *
 * The note under an answer the installation was not charged for comes from
 * `readingNotCountedNote`, the one place that sentence lives.
 */
export function AskReading({
  ready,
  busy,
  reading,
  counted,
  onAsk,
}: {
  /** The draft is worth asking about. */
  ready: boolean;
  /** A read is in flight. */
  busy: boolean;
  /** What the model answered, or null before the first answer. */
  reading: string | null;
  /** Whether that answer was counted against the installation's model use. */
  counted: boolean;
  onAsk: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={onAsk}
        disabled={busy || !ready}
      >
        {busy ? t("Reading…") : t("Ask the model to read it")}
      </button>
      {reading && (
        <div className="card" style={{ marginTop: 12 }}>
          <p className="hint" style={{ marginTop: 0 }}>
            {t("What the model said about this draft:")}
          </p>
          <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{reading}</p>
          {!counted && <p className="hint">{readingNotCountedNote()}</p>}
        </div>
      )}
    </>
  );
}
