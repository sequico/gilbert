import type { RunDoc, RunState, RunStep, RunStepState } from "@gilbert/shared/run";
import type { FactDoc, RunListing } from "@/lib/agentAdmin";
import { formatFullDate } from "@/lib/format";
import { t } from "@/lib/i18n";

/**
 * How a step of a plan left it, in a reader's words (ADR 0030).
 *
 * The four states are the document's own, held in one table and translated where
 * they are drawn — a run is a record of what happened, and "skipped" on its own
 * says nothing about whether the work was refused or never reached. The same
 * words read the **branch** a step takes: "after step 2 if it ended Worked" is the
 * plan's own condition, and a step left unrun is the branch nobody reached.
 */
const STEP_STATE_LABELS: Record<RunStepState, string> = {
  open: "Not run yet",
  done: "Worked",
  failed: "Refused",
  skipped: "Not reached",
};

/** How a run ended, or that it is still in flight (ADR 0030). */
export const RUN_STATE_LABELS: Record<RunState, string> = {
  running: "Running",
  done: "Finished",
  blocked: "Blocked on a person",
  "out-of-budget": "Out of budget",
  cancelled: "Stopped",
};

/** How long an outcome is drawn inline before it moves behind a fold. */
const OUTCOME_INLINE_MAX = 240;

/** One run, drawn as the record carries it: what woke it, its plan, its tally. */
export function RunCard({
  listed,
  facts,
}: {
  listed: RunListing;
  facts: readonly FactDoc[];
}) {
  const { run, problem } = listed;
  if (!run)
    return (
      <div className="run-card">
        <div className="run-head">
          <span className="run-id">{listed.id}</span>
        </div>
        {/* Said rather than drawn: a run this build cannot read is a defect the
            installation has, and an empty run would be a record invented. */}
        <div className="error-box">{problem}</div>
      </div>
    );
  return <RunDocument run={run} facts={facts} />;
}

/**
 * One fact the run recalled, as the screen can say it now.
 *
 * The record names the sheets by id (ADR 0033) and the surface holds the
 * memory's own list, so the id is resolved to the sheet that carries it; one
 * that has since been removed is drawn by its id, because that is all the
 * record says about it.
 */
function recalledFact(id: string, facts: readonly FactDoc[]): string {
  const fact = facts.find((held) => held.id === id);
  return fact ? `${fact.subject} — ${fact.fact}` : id;
}

/** The run itself: the change, the rule, the plan with its order, the tally. */
function RunDocument({ run, facts }: { run: RunDoc; facts: readonly FactDoc[] }) {
  const {
    startedBy,
    plan,
    spent,
    waiting,
    ended,
    recalled,
    touched,
    authorisations,
    answerRefusals,
  } = run;
  const origin = startedBy.rule
    ? t("Started by the rule {rule}, woken by {change}.", {
        rule: startedBy.rule,
        change: startedBy.woke ?? "",
      })
    : t("Started by an instruction in {channel} {id}, woken by {change}.", {
        channel: startedBy.instruction?.channel ?? "",
        id: startedBy.instruction?.id ?? "",
        change: startedBy.woke ?? "",
      });
  const tokens = (spent.promptTokens ?? 0) + (spent.completionTokens ?? 0);
  return (
    <div className="run-card">
      <div className="run-head">
        <span className="run-id">{run.id}</span>
        <span className={`run-state run-state-${run.state}`}>
          {t(RUN_STATE_LABELS[run.state])}
        </span>
        <span className="run-origin">{origin}</span>
        <span className="run-when">
          {formatFullDate(run.startedAt) || "—"} →{" "}
          {formatFullDate(ended?.at) || t("Running")}
        </span>
      </div>
      {startedBy.surfaces && (
        <p className="hint">
          {t("Surfaces")}:{" "}
          {Object.entries(startedBy.surfaces)
            .map(([surface, mode]) => `${surface} ${mode}`)
            .join(" · ")}
        </p>
      )}
      {plan.length > 0 && (
        <ol className="run-plan">
          {plan.map((step, index) => (
            <li key={index} className={`run-step run-step-${step.state}`}>
              <span className="run-dot" aria-hidden="true" />
              <Step step={step} />
            </li>
          ))}
        </ol>
      )}
      <div className="run-foot">
        <div className="run-foot-chips">
          <span>
            {t("Spent: {steps} steps, {calls} model calls, {ms} ms of work.", {
              steps: spent.steps,
              calls: spent.calls,
              ms: spent.ms,
            })}
          </span>
          <span>
            {t("Tokens")}: {tokens}
          </span>
        </div>
        {touched.length > 0 && (
          <div>
            {t("Touched: {touched}.", {
              touched: touched.map((ref) => `${ref.kind} ${ref.id}`).join(", "),
            })}
          </div>
        )}
        {authorisations.map((one, at) => (
          <div key={`${one.by}-${at}`}>
            {t("Authorised by {by}: {authority} for {target} — “{what}”", {
              by: one.by,
              authority: one.authority,
              target: one.act.target,
              what: one.what,
            })}
          </div>
        ))}
        {(answerRefusals ?? []).map((one, at) => (
          <div key={`${one.message.id}-${at}`}>
            {t("An answer from {from} was not a person's word: {code}", {
              from: one.from,
              code: one.code,
            })}
          </div>
        ))}
        {recalled.length > 0 && (
          <div>
            {t("Recalled: {facts}.", {
              facts: recalled.map((id) => recalledFact(id, facts)).join("; "),
            })}
          </div>
        )}
        {waiting && (
          <div>
            {waiting.until
              ? t("Waiting: {what} — asked in {channel} {id}, until {until}", {
                  what: waiting.what,
                  channel: waiting.asked.channel,
                  id: waiting.asked.id,
                  until: formatFullDate(waiting.until),
                })
              : t("Waiting: {what} — asked in {channel} {id}", {
                  what: waiting.what,
                  channel: waiting.asked.channel,
                  id: waiting.asked.id,
                })}
          </div>
        )}
        {ended && (
          <div>
            {t("Ended {when}: {why}", {
              when: formatFullDate(ended.at),
              why: ended.why,
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** One step: what it is, what it waited on, and how it left the plan. */
function Step({ step }: { step: RunStep }) {
  const label = t(STEP_STATE_LABELS[step.state]);
  const folded = step.outcome.length > OUTCOME_INLINE_MAX || step.outcome.includes("\n");
  return (
    <>
      <div className="run-step-what">{step.what}</div>
      {step.needs && (
        <div className="run-step-meta">
          {t("After step {n} if it ended {outcome}", {
            n: step.needs.step + 1,
            outcome: t(STEP_STATE_LABELS[step.needs.when]),
          })}
        </div>
      )}
      <div className="run-step-meta">
        <strong className={`run-step-state ${step.state}`}>{label}</strong>
        {step.outcome && !folded ? ` — ${step.outcome}` : ""}
      </div>
      {step.outcome && folded && (
        <details>
          <summary className="run-step-meta">{t("What it answered")}</summary>
          <div className="run-outcome">{step.outcome}</div>
        </details>
      )}
    </>
  );
}
