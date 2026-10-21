import type { Email } from "@/jmap/types";
import { t as translate } from "@/lib/i18n";
import { spamModelOpinion } from "@/lib/spamScore";

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
                  // The word is Stalwart's own (LOW/MEDIUM/HIGH), read as a
                  // category's label and translated like one.
                  confidence: translate(opinion.confidence),
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
