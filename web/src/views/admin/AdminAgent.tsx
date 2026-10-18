import { errorMessage } from "@gilbert/shared/errors";
import type { RunDoc, RunState, RunStep, RunStepState } from "@gilbert/shared/run";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  correctFact,
  dismissProposal as dismissProposalSheet,
  type FactDoc,
  fetchAgentStatus,
  fetchFacts,
  fetchGroupRuns,
  forgetFact,
  type RunListing,
} from "@/lib/agentAdmin";
import { formatFullDate } from "@/lib/format";
import { t, tNode } from "@/lib/i18n";
import { fetchInstallation, installationModel } from "@/lib/installationAdmin";
import { confirmDialog } from "@/ui/dialog";
import { LoadState } from "@/ui/LoadState";
import { DirectoryLoadError, DirectoryNotListed, useGroupDirectory } from "./directory";

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
};

/** One run, drawn as the record carries it: what woke it, its plan, its tally. */
function RunCard({ listed, facts }: { listed: RunListing; facts: readonly FactDoc[] }) {
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

/** One fact of the installation's memory, as a person reads and corrects it. */
function FactCard({
  fact,
  busy,
  onSave,
  onRemove,
  onDismissProposal,
}: {
  fact: FactDoc;
  busy: boolean;
  onSave: (id: string, edit: { subject: string; fact: string }) => Promise<void>;
  onRemove: (fact: FactDoc) => Promise<void>;
  onDismissProposal: (fact: FactDoc) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(fact.subject);
  const [sentence, setSentence] = useState(fact.fact);
  useEffect(() => {
    setSubject(fact.subject);
    setSentence(fact.fact);
  }, [fact.subject, fact.fact]);
  const dirty = subject !== fact.subject || sentence !== fact.fact;

  if (!editing)
    return (
      <div className="card">
        <div className="card-head">
          <h3>{fact.subject}</h3>
        </div>
        <p>{fact.fact}</p>
        <p className="hint">
          {fact.origin.by === "person"
            ? t(
                "A person ({who}) wrote this on {when} — it is in force, so the agent proposes against it and never overwrites it.",
                {
                  who: fact.origin.who,
                  when: formatFullDate(fact.at),
                },
              )
            : t("The run {run} learned this on {when}.", {
                run: fact.origin.run,
                when: formatFullDate(fact.at),
              })}
        </p>
        {/* A correction is drawn beside the origin, not in place of it: the
            sheet still says which run concluded this, and who overruled it. */}
        {fact.correction && (
          <p className="hint">
            {t(
              "A person ({who}) corrected it on {when} — it is in force, so the agent proposes against it and never overwrites it.",
              {
                who: fact.correction.who,
                when: formatFullDate(fact.correction.at),
              },
            )}
          </p>
        )}
        {/* What the agent concluded against the person's word (ADR 0037): a
            proposal beside it, which a person accepts — making those words their
            own correction — or dismisses, leaving the sheet as it was. */}
        {fact.proposal && (
          <div className="fact-proposal">
            <p>{t("The agent proposes: {fact}", { fact: fact.proposal.fact })}</p>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  void onSave(fact.id, {
                    subject: fact.subject,
                    fact: fact.proposal?.fact ?? fact.fact,
                  })
                }
              >
                {t("Accept")}
              </button>
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => void onDismissProposal(fact)}
              >
                {t("Dismiss")}
              </button>
            </div>
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" disabled={busy} onClick={() => setEditing(true)}>
            {t("Edit")}
          </button>
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() =>
              void (async () => {
                const ok = await confirmDialog({
                  title: t("Delete “{name}”?", { name: fact.subject }),
                  message: t(
                    "The fact leaves the installation's memory, and every call that carried it stops carrying it.",
                  ),
                  confirmLabel: t("Delete"),
                  danger: true,
                });
                if (ok) await onRemove(fact);
              })()
            }
          >
            {t("Delete")}
          </button>
        </div>
      </div>
    );

  return (
    <div className="card">
      <div className="field">
        <label htmlFor={`subject-${fact.id}`}>{t("Subject")}</label>
        <input
          id={`subject-${fact.id}`}
          className="input"
          value={subject}
          disabled={busy}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`fact-${fact.id}`}>{t("Fact")}</label>
        <textarea
          id={`fact-${fact.id}`}
          className="textarea"
          value={sentence}
          disabled={busy}
          onChange={(e) => setSentence(e.target.value)}
        />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="btn btn-primary"
          disabled={busy || !dirty}
          onClick={() => void onSave(fact.id, { subject, fact: sentence })}
        >
          {t("Save")}
        </button>
        <button
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => {
            setSubject(fact.subject);
            setSentence(fact.fact);
            setEditing(false);
          }}
        >
          {t("Cancel")}
        </button>
      </div>
    </div>
  );
}

/**
 * The installation's agent, as an administrator reads it: where it is, the runs
 * a group has worked, and the facts it reasons from (ADR 0031, 0034, 0036,
 * 0037).
 *
 * Three reads and two writes, and **nothing here starts or stops anything**:
 * the agent is part of the server, its own boot starts it and the supervisor
 * asks for a pass on an interval (`agent/supervisor.ts`). A control on this
 * surface would promise something the server cannot keep.
 *
 * The model is the installation's own document, so it is **linked** to the
 * section that chooses it rather than kept as a second set of fields here; the
 * claim and the pass interval are the two facts about the process that no
 * document the browser can reach on its own carries.
 *
 * The runs live in the group's own account and the facts in the **Master's**, and
 * both are read and written as the installation through the server's routes — a
 * browser may not write that app folder itself, and the door is the installation
 * administrator's own, the same one every other administration surface is behind.
 */
export function AdminAgent() {
  const [claim, setClaim] = useState<AgentStatus["claim"]>(null);
  const [passSeconds, setPassSeconds] = useState(0);
  const [modelLine, setModelLine] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [facts, setFacts] = useState<FactDoc[]>([]);
  const [factsError, setFactsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const directory = useGroupDirectory();
  const [group, setGroup] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunListing[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);

  async function load() {
    setLoadError(null);
    try {
      // Two reads, one screen: the claim comes from the installation's own
      // account and the model from the document the installation section edits,
      // each through its own reader.
      const [status, installation] = await Promise.all([
        fetchAgentStatus(),
        fetchInstallation(),
      ]);
      setClaim(status.claim);
      setPassSeconds(status.passSeconds);
      setModelLine(installation.document);
      setLoaded(true);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
    void loadFacts();
  }

  async function loadFacts() {
    setFactsError(null);
    try {
      setFacts(await fetchFacts());
    } catch (err) {
      setFactsError(errorMessage(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function select(name: string) {
    setGroup(name);
    setRuns(null);
    setRunsError(null);
    try {
      setRuns(await fetchGroupRuns(name));
    } catch (err) {
      setRunsError(errorMessage(err));
    }
  }

  async function save(id: string, edit: { subject: string; fact: string }) {
    if (busy) return;
    setBusy(true);
    try {
      await correctFact(id, edit);
      await loadFacts();
    } catch (err) {
      setFactsError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function dismissProposal(fact: FactDoc) {
    if (busy) return;
    setBusy(true);
    try {
      await dismissProposalSheet(fact.id);
      await loadFacts();
    } catch (err) {
      setFactsError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(fact: FactDoc) {
    if (busy) return;
    setBusy(true);
    try {
      await forgetFact(fact.id);
      await loadFacts();
    } catch (err) {
      setFactsError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded)
    return (
      <div>
        <h1>{t("Agent")}</h1>
        <LoadState loadError={loadError} reload={() => void load()} loading={!loaded} />
      </div>
    );

  const model = installationModel(modelLine);
  return (
    <div>
      <h1>{t("Agent")}</h1>
      <p className="lead">
        {t(
          "The agent is part of the server: its own boot starts it and it asks for a pass every {n} seconds, working what the installation's groups have changed. Nothing on this page starts or stops it.",
          { n: passSeconds },
        )}
      </p>

      <section>
        <h2>{t("The installation's model")}</h2>
        {model.provider ? (
          <p className="hint">
            {t("{provider} · {model} · {url}", {
              provider: model.provider,
              model: model.model,
              url: model.baseUrl,
            })}
          </p>
        ) : (
          <p className="hint">
            {t(
              "No model is named, so this installation has no agent: it stays idle and says so in the server's log.",
            )}
          </p>
        )}
        <p className="hint">
          {tNode(
            "The model is chosen in {section}, and a publish there applies at the next boot.",
            { section: <Link to="/admin/installation">{t("Installation")}</Link> },
          )}
        </p>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>{t("The installation's claim")}</h2>
        {claim ? (
          <p className="hint">
            {t("Held by {who} since {when}, and believed until {until}.", {
              who: claim.holder,
              when: formatFullDate(claim.takenAt),
              until: formatFullDate(claim.expires),
            })}
          </p>
        ) : (
          <p className="hint">
            {t(
              "Nobody holds it. A claim is free until a process takes it, and a claim nobody renews is free again when its instant passes.",
            )}
          </p>
        )}
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>{t("Runs")}</h2>
        <p className="hint">
          {t(
            "Each run is one document in the group's own account: the change that woke it, the plan with what each step waited on, every step's outcome, what it spent, and where it parked.",
          )}
        </p>
        {directory.loadError && (
          <DirectoryLoadError loadError={directory.loadError} reload={directory.reload} />
        )}
        {!directory.loading && !directory.enumeration && !directory.loadError && (
          <DirectoryNotListed message={directory.enumerationMessage}>
            {t(
              "Listing group mailboxes needs Stalwart server-administrator privilege, which this session does not have.",
            )}
          </DirectoryNotListed>
        )}
        {directory.enumeration && (
          <>
            <div className="field" style={{ maxWidth: "28rem" }}>
              <label htmlFor="agent-runs-group">{t("Group mailbox")}</label>
              <select
                id="agent-runs-group"
                className="select"
                value={group ?? ""}
                onChange={(e) => {
                  if (e.target.value) void select(e.target.value);
                }}
              >
                <option value="">{t("Choose a group…")}</option>
                {directory.groups.map((g) => (
                  <option key={g.id} value={g.name}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
            {runsError && (
              <div className="error-box" style={{ marginTop: 12 }}>
                {runsError}
              </div>
            )}
            {group && !runsError && !runs && <p className="hint">{t("Loading…")}</p>}
            {runs && runs.length === 0 && (
              <p className="hint">{t("Nothing here yet.")}</p>
            )}
            <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
              {runs?.map((row) => (
                <RunCard key={row.id} listed={row} facts={facts} />
              ))}
            </div>
          </>
        )}
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>{t("Facts")}</h2>
        <p className="hint">
          {t(
            "The installation's memory, in the Master's own account: one small fact per sheet, with the run or the person it came from and the person who corrected it, if anyone did. What a person writes or corrects here is in force — the agent reasons from it and proposes against it rather than overwriting it, and the next pass reads it with no restart.",
          )}
        </p>
        {factsError && (
          <div className="error-box" style={{ marginTop: 12 }}>
            {factsError}
          </div>
        )}
        {facts.length === 0 && !factsError && (
          <p className="hint">{t("Nothing here yet.")}</p>
        )}
        <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
          {facts.map((fact) => (
            <FactCard
              key={fact.id}
              fact={fact}
              busy={busy}
              onSave={save}
              onRemove={remove}
              onDismissProposal={dismissProposal}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
