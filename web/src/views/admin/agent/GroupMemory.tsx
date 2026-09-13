/**
 * A group's notebook, as an administrator keeps it (ADR 0003).
 *
 * Memory is a document in the group's own account: the facts its agent holds in
 * every call — how this group's mail is filed, what its clients are called,
 * which language it works in, the exceptions somebody wrote down. Each fact is
 * a line, and a line is what a person adds, corrects or removes; the whole list
 * is written back at once, because the list is what the document holds.
 *
 * The bounds the form states are the ones the document enforces: they arrive
 * with the read rather than being written down a second time here.
 *
 * The group is handed in rather than picked here (ADR 0003): the Group Agents
 * workspace owns one pick for all of its tabs.
 */

import type { AgentNotebookFact } from "@gilbert/agent/documents";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchGroupNotebook, saveAgentNotebook } from "@/lib/agents";
import { groupAccessSentence } from "@/lib/groupAccess";
import { t } from "@/lib/i18n";
import { toast } from "@/ui/toast";

/** One fact being edited: the id it came with, and the text as typed. */
interface FactDraft {
  id: string;
  text: string;
}

export function GroupMemory({ group, known }: { group: string; known: boolean }) {
  const [facts, setFacts] = useState<FactDraft[] | null>(null);
  const [stamps, setStamps] = useState<{ at: string | null; by: string | null }>({
    at: null,
    by: null,
  });
  const [bounds, setBounds] = useState({ maxFact: 0, maxFacts: 0 });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  // A group's memory belongs to that group, so switching drops the draft
  // rather than carrying one group's facts into another's document.
  useEffect(() => {
    setFacts(null);
    setChanged(false);
    setProblem(null);
  }, [group]);

  const load = async () => {
    if (!group) return;
    setBusy(true);
    setProblem(null);
    try {
      const view = await fetchGroupNotebook(group);
      setFacts(
        view.facts.map((fact: AgentNotebookFact) => ({ id: fact.id, text: fact.text })),
      );
      setStamps({ at: view.updatedAt, by: view.updatedBy });
      setBounds({ maxFact: view.maxFact, maxFacts: view.maxFacts });
      setChanged(false);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const write = async () => {
    if (!group || !facts) return;
    setBusy(true);
    setProblem(null);
    try {
      const view = await saveAgentNotebook(group, facts);
      setFacts(
        view.facts.map((fact: AgentNotebookFact) => ({ id: fact.id, text: fact.text })),
      );
      setStamps({ at: view.updatedAt, by: view.updatedBy });
      setChanged(false);
      toast.success(t("Memory saved"));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const edit = (index: number, text: string) => {
    if (!facts) return;
    setFacts(facts.map((fact, i) => (i === index ? { ...fact, text } : fact)));
    setChanged(true);
  };

  const remove = (index: number) => {
    if (!facts) return;
    setFacts(facts.filter((_, i) => i !== index));
    setChanged(true);
  };

  // A new fact has no id yet: the server gives it one, which is what keeps the
  // rule for ids in one place.
  const add = () => {
    if (!facts) return;
    setFacts([...facts, { id: "", text: "" }]);
    setChanged(true);
  };

  return (
    <section>
      <h2>{t("Memory")}</h2>
      <p className="lead">
        {t(
          "What the group's agent holds in every call: the facts about this group that its automations should never have to repeat. Each line is read as data — it steers, and it never widens what an automation is allowed to do.",
        )}
      </p>

      {!group && (
        <p className="hint">
          {t("No group is picked, so there is no memory to read here.")}
        </p>
      )}

      {problem && (
        <div className="error-box" style={{ marginBottom: 12 }}>
          {problem}
        </div>
      )}

      {group && !known && (
        <div className="warn-box" style={{ marginBottom: 12 }}>
          {groupAccessSentence("agent documents")}
        </div>
      )}

      {group && known && facts === null && (
        <p className="hint">
          {busy ? t("Loading…") : t("This group's memory has not been read yet.")}{" "}
          <button className="btn btn-sm" disabled={busy} onClick={() => void load()}>
            {t("Read it")}
          </button>
        </p>
      )}

      {facts !== null && (
        <>
          {facts.length === 0 ? (
            <p className="hint">{t("This group's agent is holding nothing yet.")}</p>
          ) : (
            <div className="agent-actions">
              {facts.map((fact, index) => (
                <div className="agent-action" key={fact.id || `new-${index}`}>
                  <div className="agent-action-head">
                    <b>{t("Fact {n}", { n: index + 1 })}</b>
                    <button
                      type="button"
                      className="icon-btn xs danger"
                      aria-label={t("Remove this fact")}
                      onClick={() => remove(index)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <textarea
                    className="textarea"
                    rows={2}
                    maxLength={bounds.maxFact || undefined}
                    value={fact.text}
                    placeholder={t(
                      "Invoices from Ada are filed under the client's name, not the sender's.",
                    )}
                    onChange={(e) => edit(index, e.target.value)}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || (bounds.maxFacts > 0 && facts.length >= bounds.maxFacts)}
              onClick={add}
            >
              <Plus size={14} /> {t("Add a fact")}
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || !changed}
              onClick={() => void write()}
            >
              {busy ? t("Saving…") : t("Save")}
            </button>
          </div>

          <p className="hint">
            {stamps.by
              ? t("Last written by {who} on {when}.", {
                  who: stamps.by,
                  when: stamps.at ? new Date(stamps.at).toLocaleString() : "",
                })
              : t("Nobody has written here yet.")}
          </p>
          <p className="hint">
            {t("A fact is at most {n} characters, and a notebook holds {m}.", {
              n: bounds.maxFact,
              m: bounds.maxFacts,
            })}
          </p>
        </>
      )}
    </section>
  );
}
