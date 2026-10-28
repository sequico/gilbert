import { errorMessage } from "@gilbert/shared/errors";
import type { CampaignOutcome, RowDoc } from "@gilbert/shared/outbound";
import { Phone, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { plural, t } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import {
  createCampaign,
  fetchDoNotCall,
  fetchToday,
  type ImportReport,
  importRows,
  setDoNotCall,
  settleRow,
  type TodayBoard,
  takeRow,
} from "@/lib/outbound";
import { useMail } from "@/store/mail";
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
export function TodayView() {
  const groups = groupMailboxAccounts(useMail((s) => s.mailAccounts));
  const [group, setGroup] = useState("");
  const [board, setBoard] = useState<TodayBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taken, setTaken] = useState<RowDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const [doNotCall, setDoNotCallNumbers] = useState<string[]>([]);

  // The group being worked: the one the caller chose, or the first they are in.
  const active = useMemo(
    () => (groups.some((g) => g.name === group) ? group : (groups[0]?.name ?? "")),
    [groups, group],
  );

  async function load(name: string) {
    setLoading(true);
    setLoadError(null);
    try {
      const [queue, blocked] = await Promise.all([
        fetchToday(name),
        fetchDoNotCall(name),
      ]);
      setBoard(queue);
      setDoNotCallNumbers(blocked);
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
  }, [active]);

  async function refresh() {
    if (active) setBoard(await fetchToday(active));
  }

  async function take(row: RowDoc) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setTaken(await takeRow(active, row.campaignUid, row.uid));
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
      <h1>{t("Today")}</h1>
      <p className="lead">
        {t(
          "The calls this list is waiting for. Take a row, call the number from your own phone, then say how it went.",
        )}
      </p>

      {groups.length > 1 && (
        <div className="field">
          <label htmlFor="today-group">{t("Group")}</label>
          <select
            id="today-group"
            className="select"
            value={active}
            onChange={(e) => setGroup(e.target.value)}
          >
            {groups.map((g) => (
              <option key={g.accountId} value={g.name}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <LoadState
        loadError={loadError}
        reload={() => void load(active)}
        loading={loading && !board}
      />

      {board && (
        <>
          <p className="hint">
            {t("{due} due · {ahead} ahead · {held} with another caller", {
              due: board.due,
              ahead: board.upcoming,
              held: board.heldByOthers,
            })}
          </p>

          {error && <div className="error-box">{error}</div>}

          <section>
            <h2>{t("Queue")}</h2>
            {board.queue.length === 0 && !taken ? (
              <Empty icon={<Phone size={22} />} title={t("Nothing left to call")}>
                {t("Every open row is done, due later, or in another caller's hands.")}
              </Empty>
            ) : (
              <>
                {taken && (
                  <TakenRow
                    row={taken}
                    outcomes={board.campaigns[taken.campaignUid]?.outcomes ?? []}
                    busy={busy}
                    onSettle={(outcome) => void settle(taken, outcome)}
                  />
                )}
                {board.queue
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

          <DoNotCallList
            numbers={doNotCall}
            busy={busy}
            onBlock={(number) => void block(number, true)}
            onAllow={(number) => void block(number, false)}
          />

          <StartList
            campaigns={board.campaigns}
            busy={busy}
            onCreated={() => void refresh()}
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
  busy,
  onSettle,
}: {
  row: RowDoc;
  outcomes: readonly CampaignOutcome[];
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
  busy,
  onCreated,
  onError,
}: {
  group: string;
  /** The running campaigns, by uid: the lists a paste can go into. */
  campaigns: Record<string, { purpose: string }>;
  busy: boolean;
  onCreated: () => void;
  onError: (message: string | null) => void;
}) {
  const [target, setTarget] = useState("");
  const [paste, setPaste] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [purpose, setPurpose] = useState("");
  const [vocabulary, setVocabulary] = useState("");
  const [working, setWorking] = useState(false);

  const chosen = target || Object.keys(campaigns)[0] || "";

  async function writeCampaign() {
    if (working) return;
    setWorking(true);
    onError(null);
    try {
      const campaign = await createCampaign(
        group,
        purpose.trim(),
        outcomesOf(vocabulary),
      );
      setPurpose("");
      setVocabulary("");
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
      <h2>{t("Start a list")}</h2>
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
    <section style={{ marginTop: 24 }}>
      <h2>{t("Do not call")}</h2>
      <p className="hint">
        {t(
          "A number on this list is never written into a campaign: the import counts it and leaves it out.",
        )}
      </p>
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
