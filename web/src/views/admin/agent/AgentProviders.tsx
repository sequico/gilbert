/**
 * The installation's model (ADR 0010 "One model serves the installation").
 *
 * One entry — provider, model, base URL and key — serves every automation:
 * nothing in the product asks an administrator to decide which model a kind of
 * work deserves. It is a document in the agent's own account — the account
 * belongs to the installation, never to a member — and the executor reads it
 * through the agent's own session.
 *
 * The API key is write-only, the way an app password is: the surface says
 * whether one is stored and accepts a new one, and a stored key is never
 * rendered back.
 */

import {
  MODEL_MAX_OUTPUT_CEILING,
  MODEL_MAX_OUTPUT_DEFAULT,
} from "@gilbert/agent/documents";
import { BrainCircuit } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import type { AgentProviderInput, AgentProviderView } from "@/lib/agents";
import { t } from "@/lib/i18n";
import { useAgents } from "@/store/agents";
import { confirmDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";

export function AgentProviders() {
  const loadProviders = useAgents((s) => s.loadProviders);
  const saveProviders = useAgents((s) => s.saveProviders);
  const view = useAgents((s) => s.providers);
  // This section's own line in the store: a read that failed said why there, and
  // showing it is the difference between "no provider" and "nobody could ask".
  const problem = useAgents((s) => s.problems.providers);
  // Only the read is waited on. A save shares the `providers` key, but a save
  // can only be made from editors a read has already seeded, so a view in hand
  // stays on screen while one is in flight.
  const reading = useAgents((s) => s.busy.providers === true);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  /**
   * The one write: an entry saves the installation's model, `null` clears it,
   * and the ceiling travels with it because both are statements about the same
   * call. A cleared installation runs no automation, which is the state the
   * executor refuses in plainly rather than a silent skip (ADR 0010).
   */
  const write = (patch: AgentProviderInput | null, maxOutputTokens: number) =>
    saveProviders({ provider: patch, maxOutputTokens });

  return (
    <section>
      <h2>{t("Model")}</h2>
      <p className="lead">
        {t(
          "The model every automation of this installation runs on: one provider, one model, one key. An installation without one has no automations — a run has nothing to decide with.",
        )}
      </p>
      {problem && (
        <div className="error-box" style={{ marginBottom: 12 }}>
          {problem}
        </div>
      )}
      {/*
       * Nothing read means nothing to edit: the editor is seeded from the read,
       * so an empty one would read as "this installation runs no model" when the
       * truth is that nobody could ask — a read that failed has already said so
       * above. With no agent registered there is nothing for the model to run
       * on, so the editor is withheld rather than offered and then refused, the
       * way the rules editor withholds itself without a grant.
       */}
      {view === null ? (
        reading && <p className="hint">{t("Loading…")}</p>
      ) : !view.address ? (
        <p className="hint" style={{ marginBottom: 12 }}>
          {t(
            "No agent is registered for this installation yet, so there is nothing for the model to run on.",
          )}
        </p>
      ) : (
        <ProviderEditor
          view={view.provider}
          maxOutputTokens={view.maxOutputTokens}
          onSave={write}
        />
      )}
    </section>
  );
}

function ProviderEditor({
  view,
  maxOutputTokens,
  onSave,
}: {
  view: AgentProviderView | null;
  /** The ceiling in force, which is the default when the installation set none. */
  maxOutputTokens: number;
  /** `null` clears the entry, which is how the installation stops running a model. */
  onSave(patch: AgentProviderInput | null, maxOutputTokens: number): Promise<void>;
}) {
  const [provider, setProvider] = useState(view?.provider ?? "");
  const [model, setModel] = useState(view?.model ?? "");
  const [baseUrl, setBaseUrl] = useState(view?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [ceiling, setCeiling] = useState(String(maxOutputTokens));
  const [busy, setBusy] = useState(false);

  /*
   * Follow the stored values, keyed on the strings rather than on the view
   * object: the store hands back a fresh object on every read, and re-seeding
   * on identity would wipe the field being typed in.
   */
  useEffect(() => {
    setProvider(view?.provider ?? "");
    setModel(view?.model ?? "");
    setBaseUrl(view?.baseUrl ?? "");
    setCeiling(String(maxOutputTokens));
  }, [view?.provider, view?.model, view?.baseUrl, maxOutputTokens]);

  /*
   * What the fields were seeded from is what "unchanged" means, so the button
   * that would write them back says so: a save offered when there is nothing to
   * save is a button whose only outcome is the same document again. A typed key
   * counts on its own, because that field is never seeded -- the stored one is
   * not handed back.
   */
  const dirty =
    apiKey.trim() !== "" ||
    provider.trim() !== (view?.provider ?? "") ||
    model.trim() !== (view?.model ?? "") ||
    baseUrl.trim() !== (view?.baseUrl ?? "") ||
    Number(ceiling) !== maxOutputTokens;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const patch: AgentProviderInput = {
      provider: provider.trim(),
      model: model.trim(),
      baseUrl: baseUrl.trim(),
    };
    // An empty key field means "keep the key you have": a stored secret is
    // never handed back to the browser, so an empty one could only ever be a
    // wipe, and wiping is not what leaving a field alone asks for.
    if (apiKey.trim()) patch.apiKey = apiKey.trim();
    setBusy(true);
    try {
      // The store rejects with the server's reason when the write is refused.
      await onSave(patch, Number(ceiling));
      setApiKey("");
      toast.success(t("Model saved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /*
   * Clear the model.
   *
   * An entry sent as `null` is the one write that removes it — an entry the
   * write omits is left as it is — so this is how "this installation runs no
   * model" is said. The stored key lives on the entry that goes, so it goes
   * with it.
   */
  const remove = async () => {
    const ok = await confirmDialog({
      title: t("Remove the model?"),
      message: t(
        "This installation runs no automation until another model is saved, and the stored API key is removed with it.",
      ),
      confirmLabel: t("Remove"),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      // The store rejects with the server's reason when the write is refused.
      await onSave(null, Number(ceiling));
      setApiKey("");
      toast.success(t("Model removed"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card agent-provider" onSubmit={(e) => void submit(e)}>
      <div className="card-head">
        <BrainCircuit size={18} className="agent-provider-icon" aria-hidden="true" />
        <h3>{t("The installation0027s model")}</h3>
        {view?.hasKey ? (
          <span className="agent-state ok">{t("A key is stored")}</span>
        ) : (
          <span className="agent-state off">{t("No key stored")}</span>
        )}
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor={`agent-provider`}>{t("Provider")}</label>
          <input
            id={`agent-provider`}
            className="input"
            value={provider}
            placeholder={t("openai")}
            onChange={(e) => setProvider(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`agent-model`}>{t("Model")}</label>
          <input
            id={`agent-model`}
            className="input"
            value={model}
            placeholder={t("A model name")}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor={`agent-base`}>{t("Base URL")}</label>
          <input
            id={`agent-base`}
            className="input"
            value={baseUrl}
            placeholder={t("https://api.example.com/v1")}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`agent-key`}>{t("API key")}</label>
          <input
            id={`agent-key`}
            className="input"
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder={view?.hasKey ? t("A key is stored") : t("Paste a new key here")}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <p className="hint">
            {t(
              "Write-only: the stored key is never shown again, and leaving this field empty keeps the key you already have.",
            )}
          </p>
        </div>
      </div>
      <div className="field">
        <label htmlFor="agent-max-output">{t("Ceiling on one answer (tokens)")}</label>
        <input
          id="agent-max-output"
          className="input"
          type="number"
          min={1}
          max={MODEL_MAX_OUTPUT_CEILING}
          value={ceiling}
          onChange={(e) => setCeiling(e.target.value)}
        />
        <p className="hint">
          {t(
            "The most one answer may cost. The provider0027s own ceiling is enormous, and an uncapped answer is an uncapped bill.",
          )}{" "}
          {t("An installation that sets none gets {n} tokens.", {
            n: MODEL_MAX_OUTPUT_DEFAULT,
          })}
        </p>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button
          className="btn btn-primary"
          disabled={
            busy || !dirty || !provider.trim() || !model.trim() || !baseUrl.trim()
          }
        >
          {busy ? t("Saving…") : t("Save")}
        </button>
        {view && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => void remove()}
          >
            {t("Remove the model")}
          </button>
        )}
      </div>
    </form>
  );
}
