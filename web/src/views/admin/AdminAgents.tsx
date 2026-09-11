/**
 * The Gilbert admin "Agents" section (ADR 0003 "Admin surfaces").
 *
 * The installation's own agent and its per-tier models live here, split into
 * three questions asked in the order a person actually asks them: is there an
 * agent and how does it sign in (Overview — the identity and the app password
 * are one story, not two tabs for one thing), which groups has it been granted
 * and what does each one tell it (Groups), and which model serves which tier
 * (Models). What a group's agent actually *does* — its automations, the
 * approvals waiting on a person, and the workers serving them — lives in Group
 * workers instead: that section already reads one group at a time, and an
 * automation is exactly that.
 *
 * Nothing here grants anything. The agent is a principal in Stalwart's own
 * directory and its membership of a group is granted in Stalwart's own
 * administration, so this section **verifies** the grant — a group without it
 * shows what that costs instead of a control that could not work.
 */
import { Bot } from "lucide-react";
import { useEffect, useState } from "react";
import { apiFetch } from "@/jmap/client";
import { agentErrorSentence } from "@/lib/agentErrors";
import {
  type AgentAddressSaved,
  type AgentStatus,
  fetchAgentAuditExport,
  saveAgentAddress,
} from "@/lib/agents";
import { t } from "@/lib/i18n";
import { useAgents } from "@/store/agents";
import { fleetReasonText } from "@/views/agent/agentText";
import { AgentProviders } from "./agent/AgentProviders";
import { AppPasswordRotate } from "./agent/AppPasswordRotate";
import { GroupInstruction } from "./agent/GroupInstruction";
import { MintedSecret } from "./agent/MintedSecret";

export function AdminAgents() {
  const status = useAgents((s) => s.status);
  // This section's own read: a save refused in another panel is that panel's
  // to report, and it has its own line here.
  const error = useAgents((s) => s.problems.status);
  const loadStatus = useAgents((s) => s.loadStatus);
  // One part at a time: the installation's own health, what each group has
  // granted and told it, and which models serve it are three questions, and
  // every surface on one page was a page nobody read.
  const [part, setPart] = useState<AgentPart>("overview");

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  return (
    <div>
      <h1>
        <Bot size={22} style={{ verticalAlign: "-3px", marginRight: 8 }} />
        {t("Agents")}
      </h1>
      <p className="lead">
        {t(
          "Gilbert's own agent acts inside mail and file storage: it works on Stalwart events and on time schedules, in the groups it has been granted. This installation runs one agent — this is how to see it, which groups it works in, which models serve it, and how it signs in.",
        )}
      </p>
      {error && (
        <div className="error-box" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div
        className="segmented"
        role="group"
        aria-label={t("Agent sections")}
        style={{ marginBottom: 16 }}
      >
        {AGENT_PARTS.map((entry) => (
          <button
            key={entry.id}
            className={part === entry.id ? "active" : ""}
            aria-pressed={part === entry.id}
            onClick={() => setPart(entry.id)}
          >
            {t(entry.label)}
          </button>
        ))}
      </div>

      {part === "overview" && (
        <>
          <Registration status={status} />
          <AppPasswordRotate />
        </>
      )}
      {part === "groups" && <Groups status={status} />}
      {part === "models" && <AgentProviders />}
    </div>
  );
}

/**
 * The parts of the agent section, in the order a person asks about them.
 */
const AGENT_PARTS = [
  { id: "overview", label: "Overview" },
  { id: "groups", label: "Groups" },
  { id: "models", label: "Models" },
] as const;

type AgentPart = (typeof AGENT_PARTS)[number]["id"];

/* ------------------------------------------------------------------ */
/* Overview: the installation's own agent                             */
/* ------------------------------------------------------------------ */

function Registration({ status }: { status: AgentStatus | null }) {
  // The identity field is a draft: the status is the truth, the field is what
  // an administrator is typing, and saving is what makes them the same.
  const loadStatus = useAgents((s) => s.loadStatus);
  const [draft, setDraft] = useState(status?.address ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // What the last save provisioned, if anything: the app password it minted —
  // shown here once, since the server never hands it back again — or the reason
  // it could not mint one, which is why no worker will be able to sign in yet.
  // Both survive a later refusal, for the reason the rotation's does.
  const [credential, setCredential] = useState<NonNullable<
    AgentAddressSaved["credential"]
  > | null>(null);
  const [credentialError, setCredentialError] = useState<NonNullable<
    AgentAddressSaved["credentialError"]
  > | null>(null);
  /**
   * The accounts on this server, as suggestions.
   *
   * The agent is an ordinary account, and typing its address from memory is how
   * a typo becomes an agent that does nothing. A refused directory leaves the
   * list empty: the field still takes an address typed by hand.
   */
  const [accounts, setAccounts] = useState<string[]>([]);

  useEffect(() => {
    setDraft(status?.address ?? "");
  }, [status?.address]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await apiFetch<{ users: Array<{ name: string }> }>(
          "/api/admin/users",
        );
        if (live) setAccounts(res.users.map((user) => user.name).filter(Boolean));
      } catch {
        /* suggestion only */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const dirty = draft.trim().toLowerCase() !== (status?.address ?? "").toLowerCase();
  // A named address the deployment holds no secret for is work the same button
  // does, so it is not dimmed behind an unchanged field — otherwise the one
  // state that most needs a save would be the one state that cannot make it.
  const needsSecret = Boolean(status?.address) && !status?.hasSecret;

  /** Name the agent, or clear the name and fall back to the deployment's. */
  async function save(address: string) {
    setSaving(true);
    setProblem(null);
    setSaved(false);
    try {
      const answer = await saveAgentAddress(address);
      setCredential(answer.credential ?? null);
      setCredentialError(answer.credentialError ?? null);
      setSaved(true);
      await loadStatus();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2>{t("The installation's agent")}</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "This section checks the agent's grant, it never writes it: membership of a group is granted in Stalwart's own administration, beside the accounts, the same way a person's is.",
        )}
      </p>
      {!status ? (
        <p className="hint">{t("Loading…")}</p>
      ) : (
        <div className="card agent-registration">
          <div className="card-head">
            <h3>{t("Identity")}</h3>
            <span className={status.configured ? "agent-state ok" : "agent-state off"}>
              {status.configured ? t("Registered") : t("Not registered")}
            </span>
          </div>
          <div className="field" style={{ maxWidth: 380 }}>
            <label htmlFor="agent-address">{t("Agent address")}</label>
            <input
              id="agent-address"
              className="input notranslate"
              translate="no"
              list="agent-address-choices"
              placeholder="gilbert@example.com"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <datalist id="agent-address-choices">
              {accounts.map((account) => (
                <option key={account} value={account} />
              ))}
            </datalist>
          </div>
          <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
            <button
              className="btn btn-primary"
              type="button"
              disabled={saving || (!dirty && !needsSecret)}
              onClick={() => void save(draft)}
              title={t(
                "Register this address as the agent, provision the app password a worker signs in with, or update it",
              )}
            >
              {saving ? t("Saving…") : t("Save address")}
            </button>
            {saved && <span className="agent-state ok">{t("Saved.")}</span>}
          </div>
          <p className="hint">
            {status.addressSource === "policy"
              ? t(
                  "Named here, and in force from the next request: the installation records it, so it survives a restart. Clearing the field and saving drops the record, and the deployment's own GILBERT_AGENT_ADDRESS applies again.",
                )
              : status.addressSource === "deployment"
                ? t(
                    "Set by the deployment (GILBERT_AGENT_ADDRESS). Naming one here overrides it, for this product and for the worker.",
                  )
                : t(
                    "Nothing names an agent yet: name one here, or set GILBERT_AGENT_ADDRESS where the installation is deployed.",
                  )}
          </p>
          <p className="hint">
            {t(
              "Gilbert acts as this address by impersonating it from your own administrator session, so naming it asks you for no password. The worker that signs in as it does need one: saving an address the deployment holds no app password for mints one here and now and shows it to you once, to put where the worker reads it. Save the address unchanged to mint one.",
            )}
          </p>
          <div className="agent-verifier-row">
            <span className={status.address ? "agent-state ok" : "agent-state off"}>
              {status.address ? t("Address named") : t("No address named")}
            </span>
            <span className={status.hasSecret ? "agent-state ok" : "agent-state off"}>
              {status.hasSecret ? t("App password deployed") : t("No app password")}
            </span>
          </div>
          {status.address && !status.hasSecret && (
            <div className="warn-box" style={{ marginTop: 12 }}>
              {t(
                "No app password for this address is deployed, so no worker can sign in as it: automations will not run until one is. Saving this address mints one and shows it here once.",
              )}
            </div>
          )}
          {credential && <MintedSecret rotation={credential} />}
          {credentialError && (
            <div className="error-box" style={{ marginTop: 12 }}>
              {agentErrorSentence(credentialError as Record<string, unknown>) ??
                credentialError.code}
            </div>
          )}
          {problem && (
            <div className="error-box" style={{ marginTop: 12 }}>
              {problem}
            </div>
          )}
          {status.reason && (
            <p className="hint" style={{ marginTop: 12 }}>
              {fleetReasonText(status.reason)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Groups: which groups have granted the agent, and what each one tells it */
/* ------------------------------------------------------------------ */

function Groups({ status }: { status: AgentStatus | null }) {
  // The group whose trail is being copied, and what went wrong when something
  // did: the copy is one request with its own line to report it on.
  const [copying, setCopying] = useState<string | null>(null);
  const [copyProblem, setCopyProblem] = useState<string | null>(null);

  /**
   * Take the copy of a group's audit trail, as JSON named for the group.
   *
   * Nothing is kept here: the file is the group's own documents, handed over
   * so an administrator holds them before the oldest month is pruned.
   */
  async function copyAudit(name: string) {
    setCopying(name);
    setCopyProblem(null);
    try {
      const trail = await fetchAgentAuditExport(name);
      const blob = new Blob([JSON.stringify(trail, null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${name.replace(/[^\w.-]+/g, "_")}.audit.json`;
      a.click();
    } catch (err) {
      setCopyProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setCopying(null);
    }
  }

  return (
    <section>
      <h2>{t("Groups")}</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "Which groups have granted the agent, and what each one tells it before every model call — its standing instruction, handed to the model first. Granting itself happens in Stalwart's own administration; this section verifies it and says so when it is missing.",
        )}
      </p>
      {status?.enumeration === false && (
        <div className="warn-box" style={{ marginBottom: 12 }}>
          {t(
            "The group mailboxes could not all be listed, so this page covers only the groups you are a member of: a group that is missing here may still be granted.",
          )}
          {status.enumerationMessage && (
            <>
              {" "}
              <code>{status.enumerationMessage}</code>
            </>
          )}
        </div>
      )}
      {!status ? (
        <p className="hint">{t("Loading…")}</p>
      ) : status.groups.length === 0 ? (
        <p className="hint">{t("No group mailbox is visible to this session.")}</p>
      ) : (
        <>
          <table className="sessions-table" style={{ marginBottom: 20 }}>
            <thead>
              <tr>
                <th>{t("Group")}</th>
                <th>{t("Agent")}</th>
                <th>{t("What that means")}</th>
                <th>{t("Audit trail")}</th>
              </tr>
            </thead>
            <tbody>
              {status.groups.map((g) => (
                <tr key={g.name}>
                  <td className="notranslate" translate="no">
                    {g.name}
                  </td>
                  <td>
                    {g.granted ? (
                      <span className="agent-state ok">{t("Granted")}</span>
                    ) : (
                      <span className="agent-state off">{t("Not granted")}</span>
                    )}
                  </td>
                  <td className="hint">
                    {g.granted
                      ? t(
                          "The agent is in this group: it appears in the group's chat and its automations run here.",
                        )
                      : t(
                          "The agent is not in this group: nobody can mention it in the group's chat and no automation runs for it. Grant it in Stalwart's own administration to change that.",
                        )}
                  </td>
                  <td>
                    <button
                      className="btn btn-sm"
                      type="button"
                      disabled={copying === g.name}
                      onClick={() => void copyAudit(g.name)}
                      title={t(
                        "Download every retained month of this group's audit trail as JSON",
                      )}
                    >
                      {copying === g.name ? t("Copying…") : t("Download as JSON")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {copyProblem && (
            <p className="error-box" style={{ marginBottom: 20 }}>
              {copyProblem}
            </p>
          )}
          <GroupInstruction groups={status.groups} />
        </>
      )}
    </section>
  );
}
