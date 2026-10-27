import type { RunDoc, RunState, RunStep, RunStepState } from "@gilbert/shared/run";
import type { FactView, RunListing } from "@/lib/agentAdmin";
import { formatFullDate, formatMs } from "@/lib/format";
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
  // A guardrail stopped the run — the liveness valve or a repeated answer — and
  // the record says which check. `out-of-budget` is what a build that had a
  // budget wrote, and reads the same way here.
  stopped: "Did not finish",
  "out-of-budget": "Did not finish",
  cancelled: "Stopped",
  refused: "Refused",
};

/** How long an outcome is drawn inline before it moves behind a fold. */
const OUTCOME_INLINE_MAX = 240;

/** One run, drawn as the record carries it: what woke it, its plan, its tally. */
export function RunCard({
  listed,
  facts,
}: {
  listed: RunListing;
  facts: readonly FactView[];
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
function recalledFact(id: string, facts: readonly FactView[]): string {
  const fact = facts.find((held) => held.id === id);
  return fact ? `${fact.entityName} — ${fact.fact}` : id;
}

/** The run itself: the change, the plan with its order, the tally. */
function RunDocument({ run, facts }: { run: RunDoc; facts: readonly FactView[] }) {
  const { startedBy, plan, spent, waiting, ended, recalled, authorisations } = run;
  const origin = `${t("Woke")}: ${startedBy.woke ?? "—"}`;
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
      {plan.length > 0 && <RunPlan steps={plan} />}
      <div className="run-foot">
        <div className="run-foot-chips">
          <span>
            {/*
              The count is the plan's steps, which is what the plan below draws
              (the same number the overview's "steps taken" adds up); what the
              run was charged is the tally's own `spent.steps`, a smaller figure
              and a different fact. The label says steps, not "spent".
            */}
            {t("Steps: {steps} · {calls} model calls · {ms} ms of work.", {
              steps: plan.length,
              calls: spent.calls,
              ms: spent.ms,
            })}
          </span>
          <span>
            {t("Tokens")}: {tokens}
          </span>
        </div>
        {/*
          What was in force when the run opened: recorded, never enforced. A pass
          that fell back to the installation's defaults left them here, so the
          numbers a reader sees are the ones the run was actually worked under —
          and the line says what they are, because no counter of them ended a run.
        */}
        {run.limits && (
          <div className="hint">
            {t("Tokens per run")}: {run.limits.maxRunTokens} · {t("Steps per run")}:{" "}
            {run.limits.maxRunSteps} · {t("Tokens per day")}: {run.limits.maxDailyTokens}{" "}
            — {t("recorded, never a budget")}
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

/**
 * A plan with each step's state, from the header a live list carries.
 *
 * The same list a run's own card draws, so a step that is "open" here and
 * "Worked" there cannot be two different marks: the live views feed it the plan
 * the server summarised, and the card feeds it the document's own.
 */
export function RunPlan({
  steps,
}: {
  steps: ReadonlyArray<Pick<RunStep, "what" | "state" | "outcome" | "ms">>;
}) {
  if (!steps.length) return null;
  return (
    <ol className="run-plan">
      {steps.map((step, index) => (
        <li key={index} className={`run-step run-step-${step.state}`}>
          <span className="run-dot" aria-hidden="true" />
          <Step step={step} />
        </li>
      ))}
    </ol>
  );
}

/** One step: what it is, what it waited on, and how it left the plan. */
function Step({
  step,
}: {
  step: Pick<RunStep, "what" | "state" | "outcome" | "ms"> & {
    needs?: RunStep["needs"];
  };
}) {
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
        {/* The step's own call: the record's answer to where the time went. */}
        {step.ms !== undefined && (
          <span className="run-step-ms">
            {" · "}
            {formatMs(step.ms)}
          </span>
        )}
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
