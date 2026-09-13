import { useEffect, useState } from "react";
import { apiFetch } from "@/jmap/client";
import { formatDateTime } from "@/lib/datetime";
import { plural, t } from "@/lib/i18n";
import { policyEnforced, refreshSettingsPolicy } from "@/lib/settingsPolicy";
import { useSettings } from "@/store/settings";
import { SettingsKeyTable } from "@/views/admin/SettingsKeyTable";

/** A valid document the editor can be reset to, with one of each section. */
const EXAMPLE = JSON.stringify(
  {
    defaults: { weekStart: 1 },
    enforced: { imagePolicy: "always", readingPane: "right" },
    changes: [{ version: "example-change", settings: { spellcheck: true } }],
  },
  null,
  2,
);

/**
 * Why one account did not receive the policy, as the server codes it.
 *
 * A code rather than a sentence: the server says what happened, this surface
 * says it in the reader's language, and a code this build does not know is
 * reported as unexplained rather than guessed at.
 */
type PublishRefusal =
  | "impersonation-refused"
  | "no-files-account"
  | "write-failed"
  | "policy-moved"
  | "directory-denied";

/**
 * One publish, as the account that made it holds it (`PublishJob`,
 * `server/src/adminPolicy.ts`).
 *
 * The same document is the answer to `POST /admin/policy` and the job a later
 * `GET /admin/policy` reads back from the publishing administrator's own app
 * folder, so this surface says the same thing about a publish it just made and
 * one made by an instance that has since restarted.
 */
interface PublishJob {
  /** This publish's id; the copies it wrote into the accounts carry it too. */
  id: string;
  /** When the publish started, ISO. */
  startedAt: string;
  /** Who published, as the address they signed in with. */
  by: string;
  population: { read: number; complete: boolean; total: number | null };
  reached: string[];
  /**
   * The accounts that were not written to. `code` is one of `PublishRefusal`,
   * and it is deliberately an open `string`: a server newer than this build
   * may send one this surface does not know, and that is reported as
   * unexplained rather than guessed at (`refusalReason`).
   */
  unreached: Array<{ address: string; code: PublishRefusal | string; message: string }>;
  complete: boolean;
  /** What the server said when it refused to list the directory at all. */
  directory?: string;
}

/**
 * The sentence a refusal code earns, in the reader's language.
 *
 * The server's own `message` is English prose written for a log; the code is
 * the contract, and it is what this surface composes a sentence from — so the
 * sentence says exactly what the server said happened and nothing more. A code
 * this build does not know is not silently rounded to "it failed": it is
 * reported as unexplained, because inventing a reason for one is a claim the
 * outcome does not make.
 */
function refusalReason(code: string): string {
  switch (code) {
    case "policy-moved":
      return t(
        "the account changed while the policy was being written, so nothing was written to it",
      );
    case "impersonation-refused":
      return t("the server would not act as this account");
    case "no-files-account":
      return t("the account has no Files account to hold the policy");
    case "write-failed":
      return t("the write was refused");
    case "directory-denied":
      return t("the directory would not list it");
    default:
      return t("the server did not say why");
  }
}

/**
 * When a publish started, in the reader's own date format.
 *
 * The job is read back from the account, so a `startedAt` nothing can parse is
 * possible; it is shown as the stored text rather than thrown at the reader by
 * a formatter that only handles real dates.
 */
function startedAtText(startedAt: string): string {
  const at = new Date(startedAt);
  return Number.isNaN(at.getTime()) ? startedAt : formatDateTime(at);
}

/**
 * The sentence a publish earns.
 *
 * "Published" is only true of an installation that carries the policy in every
 * account the directory listed, so anything short of that says what is missing
 * — a directory that could not be read at all, a listing that was not the
 * whole directory, the population it did read, and the accounts that were not
 * written to with the reason for each — instead of letting a count of
 * successes read as success. Every part of it comes from the job's own fields:
 * the names from `unreached`, the reasons from their codes, and the counts from
 * the population the directory reported, so the sentence cannot claim more than
 * the outcome does.
 */
function publishNotice(job: PublishJob): string {
  if (job.complete) {
    return plural(
      job.reached.length,
      {
        one: "Published. The directory listed one account, and it carries this policy now; the other signed-in clients will sign in again.",
        other:
          "Published. The directory listed {n} accounts, and they all carry this policy now; the other signed-in clients will sign in again.",
      },
      { n: job.reached.length },
    );
  }
  const parts = [t("The policy was not published everywhere.")];
  if (job.directory) {
    parts.push(
      t(
        "The directory could not be listed, so there was no population to publish to beyond the publisher's own account.",
      ),
    );
  } else {
    parts.push(
      plural(
        job.population.read,
        {
          one: "The directory listed one account.",
          other: "The directory listed {n} accounts.",
        },
        { n: job.population.read },
      ),
    );
    if (!job.population.complete)
      parts.push(
        t(
          "That listing was not the whole directory, so any account it did not list was not reached.",
        ),
      );
  }
  if (job.unreached.length) {
    parts.push(
      plural(
        job.unreached.length,
        {
          one: "One account was not written to:",
          other: "{n} accounts were not written to:",
        },
        { n: job.unreached.length },
      ),
    );
    parts.push(
      job.unreached
        .map((one) => `${one.address} — ${refusalReason(one.code)}`)
        .join("; "),
    );
  }
  return parts.join(" ");
}

/**
 * The installation-wide policy editor (ADR 0001).
 *
 * v1 edits the policy as one JSON document — the same shape upstream's boot
 * path reads — with the key list beside it; there is no per-key form yet, and
 * the per-user surface (ADR 0001) is a later layer on the same document
 * shape. Publishing validates server-side with the boot path's rules,
 * replaces the running copy at once, and kicks the other signed-in sessions
 * so their next sign-in applies it.
 */
export function AdminPolicy() {
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * The last publish this account recorded: the one just made, or the one an
   * earlier session made — the surface reads it from the account, so reopening
   * this page says what the last publish did rather than nothing at all.
   */
  const [job, setJob] = useState<PublishJob | null>(null);
  /** What the server last held: what "unchanged" is measured against. */
  const [baseline, setBaseline] = useState("");
  // A publish with nothing to publish is not a state the button should offer.
  const dirty = text !== baseline;

  async function load() {
    setLoadError(null);
    try {
      const res = await apiFetch<{ policy: string; job: PublishJob | null }>(
        "/api/admin/policy",
      );
      setText(res.policy);
      setBaseline(res.policy);
      setJob(res.job ?? null);
      setLoaded(true);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function publish() {
    if (saving) return;
    setError(null);
    try {
      JSON.parse(text);
    } catch {
      setError(t("That is not valid JSON — fix the document and publish again."));
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch<{ job: PublishJob }>("/api/admin/policy", {
        method: "POST",
        body: text,
      });
      // What the server holds now is the document just sent, so there is
      // nothing left for the button to publish until the text moves again.
      setBaseline(text);
      /*
       * The job the server recorded, which is also what it answered: the
       * notice below is composed from it and from nothing else, so the surface
       * cannot report more than the outcome does.
       */
      setJob(res.job);
      /*
       * The published policy applies to this session at once: the client
       * caches the policy per page, and the publisher's own session is
       * deliberately not kicked (ADR 0001), so without a refresh this tab
       * would keep enforcing the pre-publish policy.
       */
      await refreshSettingsPolicy();
      const enforced = policyEnforced();
      if (Object.keys(enforced).length) {
        useSettings.getState().update({ ...enforced });
      }
      useSettings.getState().applyPolicyChanges();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function insertExample() {
    if (
      text.trim() !== EXAMPLE.trim() &&
      text.trim() &&
      !window.confirm(
        t("Replace the document with the example? Unsaved edits will be lost."),
      )
    )
      return;
    setError(null);
    setText(EXAMPLE);
  }

  if (!loaded) {
    return (
      <div>
        <h1>{t("Installation-wide policy")}</h1>
        {loadError ? (
          <>
            <div className="error-box">{loadError}</div>
            <p>
              <button className="btn" onClick={() => void load()}>
                {t("Retry")}
              </button>
            </p>
          </>
        ) : (
          <p className="hint">{t("Loading…")}</p>
        )}
      </div>
    );
  }

  return (
    <div>
      <h1>{t("Installation-wide policy")}</h1>
      <p className="lead">
        {t(
          "The settings this installation decides for every account. Edit the JSON document and publish: the server validates it, applies it at once, and signs the other clients out so their next sign-in picks it up.",
        )}
      </p>
      <h2>{t("The three sections")}</h2>
      <ul>
        <li>
          <code>defaults</code> —{" "}
          {t(
            "seed accounts that have never had settings of their own; readers can change them afterwards.",
          )}
        </li>
        <li>
          <code>enforced</code> —{" "}
          {t(
            "applied on every load and cannot be changed in Settings — the controls stay visible and go dead.",
          )}
        </li>
        <li>
          <code>changes</code> —{" "}
          {t(
            "applied once each, to everyone already signed up; each needs a unique version, and readers may turn it back off afterwards.",
          )}
        </li>
      </ul>
      <textarea
        className="textarea"
        aria-label={t("Policy document")}
        spellCheck={false}
        disabled={saving}
        style={{ minHeight: "18rem", fontFamily: "var(--font-mono, monospace)" }}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12 }}>
        <button
          className="btn btn-primary"
          disabled={saving || !dirty}
          onClick={() => void publish()}
        >
          {saving ? t("Publishing…") : t("Publish policy")}
        </button>
        <button className="btn btn-ghost" disabled={saving} onClick={insertExample}>
          {t("Insert example")}
        </button>
      </div>
      {job && (
        <div style={{ marginTop: 12 }}>
          <p className={job.complete ? "hint" : "error-box"}>{publishNotice(job)}</p>
          <p className="hint">
            {t("That was publish {id}, started {when} by {who}.", {
              id: job.id,
              when: startedAtText(job.startedAt),
              who: job.by,
            })}
          </p>
        </div>
      )}
      {error && (
        <div className="error-box" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
      <SettingsKeyTable />
    </div>
  );
}
