import { useEffect, useState } from "react";
import type { FactDoc } from "@/lib/agentAdmin";
import { formatFullDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { confirmDialog } from "@/ui/dialog";

/** One fact of the installation's memory, as a person reads and corrects it. */
export function FactCard({
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
        {/* What the agent concluded against the person's word (ADR 0033): a
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
