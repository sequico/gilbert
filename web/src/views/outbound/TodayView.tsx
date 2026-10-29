import { errorMessage } from "@gilbert/shared/errors";
import type {
  CampaignDoc,
  CampaignOutcome,
  CampaignWindow,
  RowDoc,
} from "@gilbert/shared/outbound";
import { Phone, X } from "lucide-react";
import { useEffect, useState } from "react";
import { addDays } from "@/lib/dates";
import { formatDateTime } from "@/lib/datetime";
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
  releaseRow,
  type ScriptPage,
  setDoNotCall,
  settleRow,
  type TodayBoard,
  takeRow,
} from "@/lib/outbound";
import { useMail } from "@/store/mail";
import { activeGroupName, useOutbound } from "@/store/outbound";
import { DateTimeField, DateField } from "@/ui/datefield";
import { confirmDialog } from "@/ui/dialog";
import { LoadState } from "@/ui/LoadState";
import { Empty } from "@/ui/misc";

/**
 * How many rows Today draws at once. The rest are one press away: a list of a
 * thousand is one document and one read, and what it must not be is a thousand
 * cards on a phone.
 */
const PAGE = 20;

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
  const { group, campaign, campaigns, findings, load: loadCampaigns } = useOutbound();
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
  /** What the call in hand said, and when to call again if it stays open. */
  const [note, setNote] = useState("");
  const [nextCall, setNextCall] = useState("");
  /** How much of the queue is drawn. */
  const [visible, setVisible] = useState(PAGE);

  // The group being worked, and the pane this route names.
  const active = activeGroupName(groups, group);
  const view = section === "do-not-call" || section === "new" ? section : "queue";
  // The queue the reader asked for, as the server answered for that set of
  // campaigns: the counts and the words beside it are about the same rows.
  const queue = board?.queue ?? [];
  // What the pane draws: the first page of the queue, and as many pages as the
  // reader asked for.
  const shown = queue.slice(0, visible);
  // The campaign a row belongs to: its purpose and its vocabulary are the document
  // the tree reads, not a second copy of them carried beside the queue.
  const campaignOf = (uid: string) => campaigns.find((entry) => entry.uid === uid);

  /**
   * Everything this section shows, read as one act: the queue, the numbers it
   * honours and the pages it may read aloud. The campaigns belong to the store the
   * tree reads, and the store answers both callers with one read.
   */
  async function read(name: string) {
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
      // The campaign list carries the vocabulary of the row in hand, so a read that
      // fails here is the pane's own failure: without it nothing can be settled.
      await loadCampaigns(name);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  // Moving group leaves the last group's rows and its numbers behind: they belong to
  // an account this screen is no longer working in.
  useEffect(() => {
    setBoard(null);
    setTaken(null);
    setVisible(PAGE);
    setLoading(true);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    void read(active);
  }, [active, campaign]);

  async function take(row: RowDoc) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setTaken(await takeRow(active, row.campaignUid, row.uid));
      // A row in hand starts with nothing said and no date: both belong to this call.
      setNote("");
      setNextCall("");
      // The script the campaign pinned travels with the row: the same words were
      // said to every number of this list (ADR 0040).
      setScript(await fetchScript(active, row.campaignUid).catch(() => null));
    } catch (err) {
      setError(errorMessage(err));
      // Somebody else may have taken it while it was on screen.
      void read(active);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Put a number on the group's do-not-call list, or take it off. It is the
   * group's promise and the group's document, so the answer is the list as the
   * server now holds it rather than a guess made here.
   */
  async function block(number: string, blocked: boolean): Promise<boolean> {
    setError(null);
    setBusy(true);
    try {
      setDoNotCallNumbers(await setDoNotCall(active, number, blocked));
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /**
   * The handoff: the rows that ended with one outcome, as a file.
   *
   * What leaves carries what the record says it must — the number, its extension,
   * the words that arrived around it, the outcome, the note, who called and when —
   * so the colleague receiving it does not have to ask the caller anything. It
   * leaves as a file the caller saves, which is the one surface this build already
   * has for a list leaving.
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
      // The outcome is the caller's own words, so the name it gives the file is
      // cleaned of what a filesystem would refuse — and of nothing else.
      downloadFile(
        [header.join(","), ...lines].join("\n"),
        "text/csv",
        `${outcome.replace(/[/\\?%*:|"<>]+/g, "-")}.csv`,
      );
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
    const purpose = campaignOf(uid)?.purpose ?? "";
    const agreed = await confirmDialog({
      title: carry
        ? t("Close “{purpose}” and carry its open rows?", { purpose })
        : t("Close “{purpose}”?", { purpose }),
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
      // Only the row of the campaign being closed leaves the caller's hands: closing
      // another list must not make a live claim disappear from the screen.
      if (taken?.campaignUid === uid) setTaken(null);
      // The campaign leaves the tree as it closes, and the queue with it: the read
      // below asks for the list as the server now holds it.
      await read(active);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /** Give the row in hand back: a tap made by mistake costs nothing. */
  async function putBack(row: RowDoc) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await releaseRow(active, row.campaignUid, row.uid);
      setTaken(null);
      await read(active);
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
      await settleRow(active, row.campaignUid, row.uid, {
        outcome,
        note: note.trim() || null,
        // A date keeps the row open until then; no date settles it.
        nextCallAt: nextCall ? new Date(nextCall).toISOString() : null,
      });
      setTaken(null);
      setNote("");
      setNextCall("");
      await read(active);
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
        reload={() => void read(active)}
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

          {board.problems.length > 0 && (
            <div className="warn-box">
              {board.problems.map((problem) => (
                <p key={problem}>{problem}</p>
              ))}
            </div>
          )}

          <section>
            {queue.length === 0 && !taken ? (
              campaigns.length === 0 ? (
                <Empty icon={<Phone size={22} />} title={t("No list yet")}>
                  {t(
                    "Start a list: give it a purpose and its outcomes, then paste the numbers into it.",
                  )}
                </Empty>
              ) : (
                <Empty icon={<Phone size={22} />} title={t("Nothing left to call")}>
                  {t("Every open row is done, due later, or in another caller's hands.")}
                </Empty>
              )
            ) : (
              <>
                {taken && (
                  <TakenRow
                    row={taken}
                    outcomes={campaignOf(taken.campaignUid)?.outcomes ?? []}
                    script={script}
                    busy={busy}
                    note={note}
                    onNote={setNote}
                    nextCall={nextCall}
                    onNextCall={setNextCall}
                    onSettle={(outcome) => void settle(taken, outcome)}
                    onRelease={() => void putBack(taken)}
                  />
                )}
                {shown
                  .filter((row) => row.uid !== taken?.uid)
                  .map((row) => {
                    const purpose = campaignOf(row.campaignUid)?.purpose;
                    return (
                      <div className="card" key={row.uid}>
                        <div className="card-head">
                          <h3>{row.e164}</h3>
                          {row.extension && (
                            <span className="tag">
                              {t("ext. {extension}", { extension: row.extension })}
                            </span>
                          )}
                          {purpose && <span className="tag">{purpose}</span>}
                          {/* After a reload the row in hand is just a row again: the
                              claim says it is still this caller's to finish. */}
                          {row.claim && <span className="tag">{t("yours now")}</span>}
                        </div>
                        {row.context && <p className="hint">{row.context}</p>}
                        <p>
                          {/* One primary on this pane: the call on the row in hand.
                              Taking another is the same list, one row further on. */}
                          <button
                            className="btn"
                            disabled={busy || taken !== null}
                            onClick={() => void take(row)}
                          >
                            {t("Take this row")}
                          </button>
                        </p>
                      </div>
                    );
                  })}
                {visible < queue.length && (
                  <p>
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() => setVisible((count) => count + PAGE)}
                    >
                      {t("Show more")}
                    </button>
                  </p>
                )}
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
            onBlock={(number) => block(number, true)}
            onAllow={(number) => void block(number, false)}
          />
        </>
      )}

      {board && view === "new" && (
        <>
          <h1>{t("Start a list")}</h1>
          <StartList
            campaigns={campaigns}
            pages={pages}
            busy={busy}
            onCreated={() => void read(active)}
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
  note,
  onNote,
  nextCall,
  onNextCall,
  onSettle,
}: {
  row: RowDoc;
  outcomes: readonly CampaignOutcome[];
  /** The words the campaign pinned, when it pinned any. */
  script: string | null;
  busy: boolean;
  note: string;
  onNote: (note: string) => void;
  /** "YYYY-MM-DDTHH:MM", or "" when the call settles the row. */
  nextCall: string;
  onNextCall: (nextCall: string) => void;
  onSettle: (outcome: string) => void;
  /** Give the row back before its call. */
  onRelease: () => void;
}) {
  // What was said to this number last time: the reason the row exists at all, and
  // what a caller reading a row they have never worked needs before dialling.
  const last = row.calls.at(-1);
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
      {last && (
        <p className="hint">
          {t("Last call: {when} · {outcome}", {
            when: formatDateTime(new Date(last.at)),
            outcome:
              outcomes.find((entry) => entry.id === last.outcome)?.label ?? last.outcome,
          })}
          {last.note && ` — ${last.note}`}
        </p>
      )}
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
      <div className="field">
        <label htmlFor="today-note">{t("What was said")}</label>
        <input
          id="today-note"
          className="input"
          value={note}
          disabled={busy}
          onChange={(e) => onNote(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="today-next-call">{t("Call again")}</label>
        <DateTimeField
          id="today-next-call"
          value={nextCall}
          disabled={busy}
          onChange={onNextCall}
        />
        <p className="hint">
          {t("A date keeps the row open until then; leaving it empty settles the row.")}
        </p>
      </div>
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
        {/* Set apart from the outcomes: giving the row back is not a way of saying
            how the call went, it is saying that there was no call. */}
        <button
          className="btn btn-ghost"
          style={{ marginLeft: "auto" }}
          disabled={busy}
          onClick={onRelease}
        >
          {t("Put it back")}
        </button>
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
 * The window as the campaign stores it: instants, from the first day's midnight to
 * the moment after the last day — a list that runs "until the 30th" is worked on
 * the 30th.
 */
function windowOf(from: string, until: string): CampaignWindow | null {
  if (from === "" && until === "") return null;
  return {
    from: from === "" ? null : new Date(`${from}T00:00:00`).toISOString(),
    to: until === "" ? null : addDays(new Date(`${until}T00:00:00`), 1).toISOString(),
  };
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
  /** The group's campaigns, closed ones included: the lists a handoff reads. */
  campaigns: readonly CampaignDoc[];
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
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const [outcome, setOutcome] = useState("");
  const [working, setWorking] = useState(false);

  // A paste goes into a list being worked; a handoff reads one that may have just
  // been closed, because handing the decided rows out is what the end of a list is.
  const running = campaigns.filter((entry) => entry.state === "running");
  const chosen = target !== "" ? target : (running[0]?.uid ?? campaigns[0]?.uid ?? "");
  const chosenCampaign = campaigns.find((entry) => entry.uid === chosen);
  const open = chosenCampaign?.state === "running";

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
        windowOf(from, until),
      );
      setPurpose("");
      setVocabulary("");
      setPage("");
      setFrom("");
      setUntil("");
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
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <div className="field">
          <label htmlFor="today-from">{t("Runs from")}</label>
          <DateField id="today-from" value={from} onChange={setFrom} />
        </div>
        <div className="field">
          <label htmlFor="today-until">{t("Runs until")}</label>
          <DateField id="today-until" value={until} onChange={setUntil} />
        </div>
      </div>
      <p className="hint">{t("Leave the dates empty for a list with no window.")}</p>
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

      {campaigns.length > 0 && (
        <div className="field">
          <label htmlFor="today-campaign">{t("Into which campaign")}</label>
          <select
            id="today-campaign"
            className="select"
            value={chosen}
            onChange={(e) => setTarget(e.target.value)}
          >
            {campaigns.map((entry) => (
              <option key={entry.uid} value={entry.uid}>
                {entry.state === "running"
                  ? entry.purpose
                  : t("{purpose} (closed)", { purpose: entry.purpose })}
              </option>
            ))}
          </select>
        </div>
      )}
      {open && (
        <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          {/* Carrying the open rows is the usual end of a list; closing them away is
              the exception, so it is the one drawn as the quieter action. */}
          <button
            className="btn"
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
      {chosenCampaign && chosenCampaign.outcomes.length > 0 && (
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
              {chosenCampaign.outcomes.map((entry) => (
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

      {open ? (
        <>
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
              disabled={disabled || paste.trim() === ""}
              onClick={() => void add()}
            >
              {t("Add to the list")}
            </button>
          </p>
        </>
      ) : (
        <p className="hint">
          {t(
            "This campaign is closed: it takes no new rows, and its decided rows can still be handed off.",
          )}
        </p>
      )}

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
                {report.refused.map((entry, index) => (
                  <li key={`${index}-${entry.line}`}>
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
  /** True when the number went on the list: what was typed stays if it did not. */
  onBlock: (number: string) => Promise<boolean>;
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
              // The word goes out, and only a number the server accepted leaves the
              // box: a refusal keeps what was typed, so it can be corrected.
              void onBlock(typed.trim()).then((added) => {
                if (added) setTyped("");
              });
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
