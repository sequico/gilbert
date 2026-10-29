import { errorMessage } from "@gilbert/shared/errors";
import type { CampaignOutcome, RowDoc } from "@gilbert/shared/outbound";
import { Phone, X } from "lucide-react";
import { useEffect, useState } from "react";
import { downloadFile } from "@/lib/download";
import { plural, t } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import {
  closeCampaign,
  createCampaign,
  fetchDoNotCall,
  fetchRows,
  fetchScript,
  fetchScriptPages,
  fetchToday,
  type ImportReport,
  importRows,
  type ScriptPage,
  setDoNotCall,
  settleRow,
  type TodayBoard,
  takeRow,
} from "@/lib/outbound";
import { useMail } from "@/store/mail";
import { activeGroupName, useOutbound } from "@/store/outbound";
import { confirmDialog } from "@/ui/dialog";
import { LoadState } from "@/ui/LoadState";
import { Empty } from "@/ui/misc";

/**
 * Today (ADR 0040): the rows a caller works, one at a time, with the phone in
 * their hand.
 *
 * The product has no telephony: a row is taken here and the call is placed from
 * the caller's own phone, which is what the `tel:` link is for. Taking a row
 * claims it for this caller and nobody else for the length of the lease, so a
 * list is never called twice at once and a caller leaving the desk costs
 * nothing.
 *
 * A campaign is a group's, so the screen names the group it works in; the queue,
 * its counts and every refusal are the server's, and this view only draws them.
 */
export function TodayView({ section }: { section?: string }) {
  const groups = groupMailboxAccounts(useMail((s) => s.mailAccounts));
  const { group, campaign, findings, load: loadCampaigns } = useOutbound();
  const [board, setBoard] = useState<TodayBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taken, setTaken] = useState<RowDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const [doNotCall, setDoNotCallNumbers] = useState<string[]>([]);
  const [pages, setPages] = useState<ScriptPage[]>([]);
  /** The words the campaign of the row in hand pinned, if it pinned any. */
  const [script, setScript] = useState<string | null>(null);

  // The group being worked, and the pane this route names.
  const active = activeGroupName(groups, group);
  const view = section === "do-not-call" || section === "new" ? section : "queue";
  // The queue the reader asked for, as the server answered for that set of
  // campaigns: the counts and the words beside it are about the same rows.
  const queue = board?.queue ?? [];

  async function load(name: string) {
    setLoading(true);
    setLoadError(null);
    try {
      const [queue, blocked, scriptPages] = await Promise.all([
        fetchToday(name, campaign),
        fetchDoNotCall(name),
        fetchScriptPages(name),
      ]);
      setBoard(queue);
      setDoNotCallNumbers(blocked);
      setPages(scriptPages);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!active) return;
    setTaken(null);
    void load(active);
    // The campaigns belong to the store the tree reads, and the store answers both
    // callers with one read.
    void loadCampaigns(active).catch(() => {});
  }, [active, campaign, loadCampaigns]);

  /** Read the queue again, and the campaign list with it: a settled row moves both. */
  async function refresh() {
    if (!active) return;
    setBoard(await fetchToday(active, campaign));
    void loadCampaigns(active).catch(() => {});
  }

  async function take(row: RowDoc) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setTaken(await takeRow(active, row.campaignUid, row.uid));
      // The script the campaign pinned travels with the row: the same words were
      // said to every number of this list (ADR 0040).
      setScript(await fetchScript(active, row.campaignUid).catch(() => null));
    } catch (err) {
      setError(errorMessage(err));
      // Somebody else may have taken it while it was on screen.
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  /**
   * Put a number on the group's do-not-call list, or take it off. It is the
   * group's promise and the group's document, so the answer is the list as the
   * server now holds it rather than a guess made here.
   */
  async function block(number: string, blocked: boolean) {
    setError(null);
    setBusy(true);
    try {
      setDoNotCallNumbers(await setDoNotCall(active, number, blocked));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * The handoff: the rows that ended with one outcome, as a file.
   *
   * What leaves carries what the record says it must — the number, who was spoken
   * to, when, by whom, the outcome and the note — so the colleague receiving it
   * does not have to ask the caller anything. It leaves as a file the caller
   * saves, which is the one surface this build already has for a list leaving.
   */
  async function handOff(campaignUid: string, outcome: string) {
    setError(null);
    try {
      const rows = (await fetchRows(active, campaignUid)).filter(
        (row) => row.state === "done" && row.calls.at(-1)?.outcome === outcome,
      );
      if (rows.length === 0) {
        setError(t("No row of this campaign ended that way."));
        return;
      }
      const header = ["number", "extension", "context", "outcome", "note", "by", "at"];
      const lines = rows.map((row) => {
        const call = row.calls.at(-1);
        return [
          row.e164,
          row.extension ?? "",
          row.context ?? "",
          call?.outcome ?? "",
          call?.note ?? "",
          call?.by ?? "",
          call?.at ?? "",
        ]
          .map((value) => `"${String(value).replace(/"/g, '""')}"`)
          .join(",");
      });
      downloadFile([header.join(","), ...lines].join("\n"), "text/csv", `${outcome}.csv`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  /**
   * Close a campaign, saying what happens to the rows still open.
   *
   * Closing is a state and never a deletion, but the rows it leaves open are the
   * group's decision: closing keeps them with the campaign that made them, and
   * carrying moves the still-open ones into a new campaign with the same purpose.
   */
  async function close(uid: string, carry: boolean) {
    const campaign = board?.campaigns[uid]?.purpose ?? "";
    const agreed = await confirmDialog({
      title: carry
        ? t("Close “{purpose}” and carry its open rows?", { purpose: campaign })
        : t("Close “{purpose}”?", { purpose: campaign }),
      message: carry
        ? t(
            "The rows still open move to a new campaign with the same purpose and outcomes.",
          )
        : t("The rows still open stay with this campaign, and it leaves Today."),
      confirmLabel: t("Close"),
    });
    if (!agreed) return;
    setError(null);
    setBusy(true);
    try {
      await closeCampaign(active, uid, carry);
      setTaken(null);
      await load(active);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function settle(row: RowDoc, outcome: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await settleRow(active, row.campaignUid, row.uid, { outcome });
      setTaken(null);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (groups.length === 0) {
    return (
      <div>
        <h1>{t("Today")}</h1>
        <Empty icon={<Phone size={22} />} title={t("No group to call for")}>
          {t(
            "A list belongs to a group, and you are in none yet. Once a group adds you, its campaigns and its list are here.",
          )}
        </Empty>
      </div>
    );
  }

  return (
    <div>
      <LoadState
        loadError={loadError}
        reload={() => void load(active)}
        loading={loading && !board}
      />

      {error && <div className="error-box">{error}</div>}

      {board && view === "queue" && (
        <>
          <h1>{t("Today")}</h1>
          <p className="lead">
            {t(
              "The calls this list is waiting for. Take a row, call the number from your own phone, then say how it went.",
            )}
          </p>

          <p className="hint">
            {t("{due} due · {ahead} ahead · {held} with another caller", {
              due: board.due,
              ahead: board.upcoming,
              held: board.heldByOthers,
            })}
          </p>

          {error && <div className="error-box">{error}</div>}

          <section>
            {queue.length === 0 && !taken ? (
              <Empty icon={<Phone size={22} />} title={t("Nothing left to call")}>
                {t("Every open row is done, due later, or in another caller's hands.")}
              </Empty>
            ) : (
              <>
                {taken && (
                  <TakenRow
                    row={taken}
                    outcomes={board.campaigns[taken.campaignUid]?.outcomes ?? []}
                    script={script}
                    busy={busy}
                    onSettle={(outcome) => void settle(taken, outcome)}
                  />
                )}
                {queue
                  .filter((row) => row.uid !== taken?.uid)
                  .map((row) => (
                    <div className="card" key={row.uid}>
                      <div className="card-head">
                        <h3>{row.e164}</h3>
                        {row.extension && (
                          <span className="tag">
                            {t("ext. {extension}", { extension: row.extension })}
                          </span>
                        )}
                        {board.campaigns[row.campaignUid]?.purpose && (
                          <span className="tag">
                            {board.campaigns[row.campaignUid]?.purpose}
                          </span>
                        )}
                      </div>
                      {row.context && <p className="hint">{row.context}</p>}
                      <p>
                        <button
                          className="btn btn-primary"
                          disabled={busy || taken !== null}
                          onClick={() => void take(row)}
                        >
                          {t("Take this row")}
                        </button>
                      </p>
                    </div>
                  ))}
              </>
            )}
          </section>

          {findings.length > 0 && (
            <div className="warn-box" style={{ marginTop: 16 }}>
              {findings.map((finding) => (
                <p key={finding.uid}>
                  {t("“{purpose}” is past its window with {open} rows still open.", {
                    purpose: finding.purpose,
                    open: finding.open,
                  })}
                </p>
              ))}
              <p className="hint">
                {t(
                  "Close it in Start a list, with or without carrying the rows still open.",
                )}
              </p>
            </div>
          )}
        </>
      )}

      {board && view === "do-not-call" && (
        <>
          <h1>{t("Do not call")}</h1>
          <p className="lead">
            {t(
              "The numbers this group promised never to call. A number here is never written into a campaign.",
            )}
          </p>
          <DoNotCallList
            numbers={doNotCall}
            busy={busy}
            onBlock={(number) => void block(number, true)}
            onAllow={(number) => void block(number, false)}
          />
        </>
      )}

      {board && view === "new" && (
        <>
          <h1>{t("Start a list")}</h1>
          <StartList
            campaigns={board.campaigns}
            pages={pages}
            busy={busy}
            onCreated={() => void refresh()}
            onClose={(uid, carry) => void close(uid, carry)}
            onHandOff={(uid, outcome) => void handOff(uid, outcome)}
            group={active}
            onError={setError}
          />
        </>
      )}
    </div>
  );
}

/**
 * The row in this caller's hands: the number to dial on the phone beside them,
 * and the campaign's own vocabulary to say how it went.
 */
function TakenRow({
  row,
  outcomes,
  script,
  busy,
  onSettle,
}: {
  row: RowDoc;
  outcomes: readonly CampaignOutcome[];
  /** The words the campaign pinned, when it pinned any. */
  script: string | null;
  busy: boolean;
  onSettle: (outcome: string) => void;
}) {
  return (
    <div className="card" style={{ borderColor: "var(--accent)" }}>
      <div className="card-head">
        <h3>{row.e164}</h3>
        {row.extension && (
          <span className="tag">
            {t("ext. {extension}", { extension: row.extension })}
          </span>
        )}
        <span className="tag">{t("yours now")}</span>
      </div>
      {row.context && <p className="hint">{row.context}</p>}
      <p>
        {/* The product has no telephony: the number is dialled by the phone this
            page is looked at on, which is the whole reason the row was taken. */}
        <a className="btn btn-primary" href={`tel:${row.e164}`}>
          <Phone size={16} /> {t("Call")}
        </a>
      </p>
      {script && (
        <div className="hint" style={{ whiteSpace: "pre-wrap", marginBottom: 10 }}>
          {script}
        </div>
      )}
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        {outcomes.map((outcome) => (
          <button
            key={outcome.id}
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => onSettle(outcome.id)}
          >
            {outcome.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Why a line became no row, in the words a person reads. The server refuses with
 * a code; the sentence is the client's, so the catalogue can translate it.
 */
const REFUSAL_LABELS: Record<string, string> = {
  no_number: "No number in this line",
  no_country: "The number does not say which country it is in",
  invalid: "No country uses this number",
  empty: "The line is empty",
};

/** The campaign's outcomes, one per line, as the caller typed them. */
function outcomesOf(text: string): CampaignOutcome[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((label) => ({ id: label, label }));
}

/**
 * Where a list comes from: a campaign is written with its purpose and its own
 * outcome vocabulary, then a paste fills it. Both are the group's, so both name
 * the group the screen is working in.
 */
function StartList({
  group,
  campaigns,
  pages,
  busy,
  onCreated,
  onClose,
  onHandOff,
  onError,
}: {
  group: string;
  /** The running campaigns, by uid: the lists a paste can go into, and their words. */
  campaigns: Record<string, { purpose: string; outcomes: CampaignOutcome[] }>;
  /** The group's knowledge pages: what a campaign may read aloud. */
  pages: readonly ScriptPage[];
  busy: boolean;
  onCreated: () => void;
  /** Close the chosen campaign, carrying its open rows or not. */
  onClose: (uid: string, carry: boolean) => void;
  /** The rows that ended with one outcome, as a file the caller keeps. */
  onHandOff: (uid: string, outcome: string) => void;
  onError: (message: string | null) => void;
}) {
  const [target, setTarget] = useState("");
  const [paste, setPaste] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [purpose, setPurpose] = useState("");
  const [vocabulary, setVocabulary] = useState("");
  const [page, setPage] = useState("");
  const [outcome, setOutcome] = useState("");
  const [working, setWorking] = useState(false);

  const chosen = target || Object.keys(campaigns)[0] || "";
  const chosenOutcomes = campaigns[chosen]?.outcomes ?? [];

  async function writeCampaign() {
    if (working) return;
    setWorking(true);
    onError(null);
    try {
      const read = pages.find((entry) => entry.nodeId === page);
      const campaign = await createCampaign(
        group,
        purpose.trim(),
        outcomesOf(vocabulary),
        read ? { nodeId: read.nodeId, revision: read.revision } : null,
      );
      setPurpose("");
      setVocabulary("");
      setPage("");
      setTarget(campaign.uid);
      onCreated();
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setWorking(false);
    }
  }

  async function add() {
    if (working || !chosen || paste.trim() === "") return;
    setWorking(true);
    onError(null);
    setReport(null);
    try {
      const imported = await importRows(group, chosen, paste);
      setReport(imported);
      setPaste("");
      onCreated();
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setWorking(false);
    }
  }

  const disabled = working || busy;

  return (
    <section style={{ marginTop: 24 }}>
      <p className="hint">
        {t(
          "A list is a campaign: a purpose, the outcomes its callers will choose, and the numbers, pasted one per line.",
        )}
      </p>

      <div className="field">
        <label htmlFor="today-purpose">{t("Purpose")}</label>
        <input
          id="today-purpose"
          className="input"
          value={purpose}
          placeholder={t("Renewals, October")}
          onChange={(e) => setPurpose(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="today-outcomes">{t("Outcomes, one per line")}</label>
        <textarea
          id="today-outcomes"
          className="textarea"
          value={vocabulary}
          placeholder={t("Spoke")}
          onChange={(e) => setVocabulary(e.target.value)}
        />
      </div>
      {pages.length > 0 && (
        <div className="field">
          <label htmlFor="today-script">{t("Script page, if the group has one")}</label>
          <select
            id="today-script"
            className="select"
            value={page}
            onChange={(e) => setPage(e.target.value)}
          >
            <option value="">{t("No script")}</option>
            {pages.map((entry) => (
              <option key={entry.nodeId} value={entry.nodeId}>
                {entry.folder}
              </option>
            ))}
          </select>
        </div>
      )}
      <p>
        <button
          className="btn"
          disabled={
            disabled || purpose.trim() === "" || outcomesOf(vocabulary).length === 0
          }
          onClick={() => void writeCampaign()}
        >
          {t("Create the campaign")}
        </button>
      </p>

      <div className="field">
        <label htmlFor="today-campaign">{t("Into which campaign")}</label>
        <select
          id="today-campaign"
          className="select"
          value={chosen}
          onChange={(e) => setTarget(e.target.value)}
          disabled={Object.keys(campaigns).length === 0}
        >
          {Object.entries(campaigns).map(([uid, campaign]) => (
            <option key={uid} value={uid}>
              {campaign.purpose}
            </option>
          ))}
        </select>
      </div>
      {chosen && (
        <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          <button
            className="btn btn-ghost"
            disabled={disabled}
            onClick={() => onClose(chosen, true)}
          >
            {t("Close it and carry the open rows")}
          </button>
          <button
            className="btn btn-ghost"
            disabled={disabled}
            onClick={() => onClose(chosen, false)}
          >
            {t("Close the campaign")}
          </button>
        </div>
      )}
      {chosen && chosenOutcomes.length > 0 && (
        <div className="field">
          <label htmlFor="today-handoff">
            {t("Hand off the rows that ended this way")}
          </label>
          <div className="row">
            <select
              id="today-handoff"
              className="select"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
            >
              <option value="">{t("Choose an outcome…")}</option>
              {chosenOutcomes.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
            <button
              className="btn"
              disabled={disabled || outcome === ""}
              onClick={() => onHandOff(chosen, outcome)}
            >
              {t("Save the file")}
            </button>
          </div>
        </div>
      )}

      <div className="field">
        <label htmlFor="today-paste">{t("Numbers, one per line")}</label>
        <textarea
          id="today-paste"
          className="textarea"
          value={paste}
          placeholder={t("ACME, ask for Tizio, +39 333 123 4567")}
          onChange={(e) => setPaste(e.target.value)}
        />
      </div>
      <p>
        <button
          className="btn btn-primary"
          disabled={disabled || !chosen || paste.trim() === ""}
          onClick={() => void add()}
        >
          {t("Add to the list")}
        </button>
      </p>

      {report && (
        <div className="hint">
          <p>
            {plural(report.added, { one: "{n} row added", other: "{n} rows added" })}
            {report.matched > 0 &&
              ` · ${plural(report.matched, { one: "{n} matched a card", other: "{n} matched a card" })}`}
            {report.duplicate > 0 &&
              ` · ${plural(report.duplicate, { one: "{n} already in the list", other: "{n} already in the list" })}`}
            {report.blocked > 0 &&
              ` · ${plural(report.blocked, { one: "{n} on do not call", other: "{n} on do not call" })}`}
          </p>
          {report.refused.length > 0 && (
            <>
              <p>
                {plural(report.refused.length, {
                  one: "{n} line could not be read",
                  other: "{n} lines could not be read",
                })}
              </p>
              <ul>
                {report.refused.map((entry) => (
                  <li key={entry.line}>
                    {entry.line} —{" "}
                    {t(REFUSAL_LABELS[entry.reason] ?? "This line could not be read")}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The group's do-not-call list: the numbers it promised never to call.
 *
 * One list for the group and not for a campaign, because a promise not to call
 * outlives the list it came from — and it is the group's document, read and
 * written through the same account as the campaigns, so the import checks it
 * without reaching anything else.
 */
function DoNotCallList({
  numbers,
  busy,
  onBlock,
  onAllow,
}: {
  numbers: readonly string[];
  busy: boolean;
  onBlock: (number: string) => void;
  onAllow: (number: string) => void;
}) {
  const [typed, setTyped] = useState("");

  return (
    <section>
      <div className="field">
        <label htmlFor="today-do-not-call">{t("Number never to call")}</label>
        <div className="row">
          <input
            id="today-do-not-call"
            className="input"
            value={typed}
            placeholder={t("Country code and number")}
            onChange={(e) => setTyped(e.target.value)}
          />
          <button
            className="btn"
            disabled={busy || typed.trim() === ""}
            onClick={() => {
              onBlock(typed.trim());
              setTyped("");
            }}
          >
            {t("Add")}
          </button>
        </div>
      </div>
      {numbers.map((number) => (
        <div className="row" key={number}>
          <span>{number}</span>
          <button
            className="icon-btn xs"
            disabled={busy}
            title={t("Allow calls again")}
            aria-label={t("Allow calls again")}
            onClick={() => onAllow(number)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </section>
  );
}
