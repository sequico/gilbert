import type { Email } from "@/jmap/types";
import { t as translate, tc } from "@/lib/i18n";
import { spamModelOpinion } from "@/lib/spamScore";

/**
 * The confidence, in the reader's language.
 *
 * The three words are Stalwart's own (LOW/MEDIUM/HIGH). They are keyed with a
 * "confidence" context because the same English words label a priority, and an
 * adjective agrees with the noun it belongs to: "confidenza alta" is not the
 * "High" of a message's priority. A literal per word, so the catalogue check
 * can see the three keys are looked up.
 */
function confidenceWord(word: string): string {
  switch (word) {
    case "Low":
      return tc("confidence", "Low");
    case "Medium":
      return tc("confidence", "Medium");
    case "High":
      return tc("confidence", "High");
    default:
      return word;
  }
}

/**
 * What the spam filter's own model said, as a row of the message details.
 *
 * It is the filter's model, never the agent's: the row says so, and the sentence
 * below it says the verdict is one of several signals the filter weighed rather
 * than the reason on its own. Nothing is drawn without the header, so a server
 * whose AI classification is off looks exactly as before.
 *
 * The explanation is model output and is rendered as text and nothing else.
 */
export function SpamModelOpinionRow({ email }: { email: Email }) {
  const opinion = spamModelOpinion(email);
  if (!opinion) return null;
  return (
    <>
      <dt>{translate("Spam filter's model")}</dt>
      <dd>
        <div className="spam-summary">
          <div>
            <strong>{opinion.category}</strong>
            {opinion.confidence && (
              <span className="hint">
                {" — "}
                {translate("{confidence} confidence", {
                  confidence: confidenceWord(opinion.confidence),
                })}
              </span>
            )}
          </div>
          {opinion.explanation && <div className="hint">{opinion.explanation}</div>}
          <div className="hint">
            {translate("One of several signals the spam filter weighed")}
          </div>
        </div>
      </dd>
    </>
  );
}
