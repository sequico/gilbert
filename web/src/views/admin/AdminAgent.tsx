import { errorMessage } from "@gilbert/shared/errors";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  type AgentStatus,
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
import { LoadState } from "@/ui/LoadState";
import { FactCard } from "./agent/FactCard";
import { RunCard } from "./agent/RunCard";
import { DirectoryLoadError, DirectoryNotListed, useGroupDirectory } from "./directory";

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
  /** Memory sheets this build could not read, as the route stated them. */
  const [factProblems, setFactProblems] = useState<string[]>([]);
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
      const reading = await fetchFacts();
      setFacts(reading.facts);
      setFactProblems(reading.problems);
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
        {factProblems.length > 0 && (
          <div className="error-box" style={{ marginTop: 12 }}>
            {factProblems.map((problem) => (
              <div key={problem}>{problem}</div>
            ))}
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
