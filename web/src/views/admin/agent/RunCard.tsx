import type { RunDoc, RunState, RunStep, RunStepState } from "@gilbert/shared/run";
import type { FactDoc, RunListing } from "@/lib/agentAdmin";
import { formatFullDate } from "@/lib/format";
import { t } from "@/lib/i18n";

/**
 * How a step of a plan left it, in a reader's words (ADR 0034).
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

/** How a run ended, or that it is still in flight (ADR 0034). */
const RUN_STATE_LABELS: Record<RunState, string> = {
  running: "Running",
  done: "Finished",
  blocked: "Blocked on a person",
  "out-of-budget": "Out of budget",
  cancelled: "Stopped",
};

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
      <div className="card">
        <div className="card-head">
          <h3>{listed.id}</h3>
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
 * The record names the sheets by id (ADR 0037) and the surface holds the
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
  const { startedBy, plan, spent, waiting, ended, recalled, touched, authorisations } =
    run;
  return (
    <div className="card">
      <div className="card-head">
        <h3>{run.id}</h3>
        <span className="hint">{t(RUN_STATE_LABELS[run.state])}</span>
      </div>
      <p className="hint">
        {startedBy.rule
          ? t("Started by the rule {rule}, woken by {change}.", {
              rule: startedBy.rule,
              change: startedBy.woke ?? "",
            })
          : t("Started by an instruction in {channel} {id}, woken by {change}.", {
              channel: startedBy.instruction?.channel ?? "",
              id: startedBy.instruction?.id ?? "",
              change: startedBy.woke ?? "",
            })}
      </p>
      {plan.length > 0 && (
        <ol style={{ paddingLeft: "1.2rem", margin: "8px 0" }}>
          {plan.map((step, index) => (
            <li key={index} style={{ marginBottom: 6 }}>
              <Step step={step} />
            </li>
          ))}
        </ol>
      )}
      <p className="hint">
        {t("Spent: {steps} steps, {calls} model calls, {ms} ms of work.", {
          steps: spent.steps,
          calls: spent.calls,
          ms: spent.ms,
        })}
      </p>
      {touched.length > 0 && (
        <p className="hint">
          {t("Touched: {touched}.", {
            touched: touched.map((ref) => `${ref.kind} ${ref.id}`).join(", "),
          })}
        </p>
      )}
      {authorisations.map((one, at) => (
        <p className="hint" key={`${one.by}-${at}`}>
          {t("Authorised by {by}: {authority} for {target} — “{what}”", {
            by: one.by,
            authority: one.authority,
            target: one.act.target,
            what: one.what,
          })}
        </p>
      ))}
      {recalled.length > 0 && (
        <p className="hint">
          {t("Recalled: {facts}.", {
            facts: recalled.map((id) => recalledFact(id, facts)).join("; "),
          })}
        </p>
      )}
      {waiting && (
        <p className="hint">
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
        </p>
      )}
      {ended && (
        <p className="hint">
          {t("Ended {when}: {why}", { when: formatFullDate(ended.at), why: ended.why })}
        </p>
      )}
    </div>
  );
}

/** One step: what it is, what it waited on, and how it left the plan. */
function Step({ step }: { step: RunStep }) {
  return (
    <>
      <div>{step.what}</div>
      {step.needs && (
        <div className="hint">
          {t("After step {n} if it ended {outcome}", {
            n: step.needs.step + 1,
            outcome: t(STEP_STATE_LABELS[step.needs.when]),
          })}
        </div>
      )}
      <div className="hint">
        <strong>{t(STEP_STATE_LABELS[step.state])}</strong>
        {step.outcome ? ` — ${step.outcome}` : ""}
      </div>
    </>
  );
}
