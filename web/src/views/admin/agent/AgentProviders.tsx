/**
 * The model providers, one per tier (ADR 0003 "Admin surfaces").
 *
 * T1's cheap classifier and T2's agent each name their own provider, model and
 * base URL, so an installation can run the tiers on different vendors or on a
 * local model. They are documents in the agent's own account — the account
 * belongs to the installation, never to a member — and the executor reads them
 * through the agent's own session.
 *
 * The API key is write-only, the way an app password is: the surface says
 * whether one is stored and accepts a new one, and a stored key is never
 * rendered back.
 */

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import type { AgentProviderInput, AgentProviderView } from "@/lib/agents";
import { t } from "@/lib/i18n";
import { useAgents } from "@/store/agents";
import { toast } from "@/ui/toast";

export function AgentProviders() {
  const loadProviders = useAgents((s) => s.loadProviders);
  const saveProviders = useAgents((s) => s.saveProviders);
  const view = useAgents((s) => s.providers);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  return (
    <section>
      <h2>{t("Model providers")}</h2>
      <p className="lead">
        {t(
          "T0 calls no model at all. Each of the tiers above it names the model it runs on, so the cheap classifier and the agent can run on different vendors, or on a model of your own.",
        )}
      </p>
      {view && !view.address && (
        <p className="hint" style={{ marginBottom: 12 }}>
          {t(
            "No agent is registered for this installation yet, so there is nothing for a tier to run on.",
          )}
        </p>
      )}
      <ProviderEditor
        tier="T1"
        view={view?.providers.T1}
        onSave={(patch) => saveProviders({ T1: patch })}
      />
      <ProviderEditor
        tier="T2"
        view={view?.providers.T2}
        onSave={(patch) => saveProviders({ T2: patch })}
      />
    </section>
  );
}

function ProviderEditor({
  tier,
  view,
  onSave,
}: {
  tier: "T1" | "T2";
  view: AgentProviderView | undefined;
  onSave(patch: AgentProviderInput): Promise<void>;
}) {
  const [provider, setProvider] = useState(view?.provider ?? "");
  const [model, setModel] = useState(view?.model ?? "");
  const [baseUrl, setBaseUrl] = useState(view?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
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
  }, [view?.provider, view?.model, view?.baseUrl]);

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
      await onSave(patch);
      setApiKey("");
      toast.success(t("{tier} provider saved", { tier }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card agent-provider" onSubmit={(e) => void submit(e)}>
      <div className="card-head">
        <h3>{t(tier)}</h3>
        {view?.hasKey ? (
          <span className="agent-state ok">{t("A key is stored")}</span>
        ) : (
          <span className="agent-state off">{t("No key stored")}</span>
        )}
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor={`agent-provider-${tier}`}>{t("Provider")}</label>
          <input
            id={`agent-provider-${tier}`}
            className="input"
            value={provider}
            placeholder={t("openai")}
            onChange={(e) => setProvider(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`agent-model-${tier}`}>{t("Model")}</label>
          <input
            id={`agent-model-${tier}`}
            className="input"
            value={model}
            placeholder={t("A model name")}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor={`agent-base-${tier}`}>{t("Base URL")}</label>
        <input
          id={`agent-base-${tier}`}
          className="input"
          value={baseUrl}
          placeholder={t("https://api.example.com/v1")}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`agent-key-${tier}`}>{t("API key")}</label>
        <input
          id={`agent-key-${tier}`}
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
      <button className="btn" disabled={busy || !provider.trim() || !model.trim()}>
        {busy ? t("Saving…") : t("Save")}
      </button>
    </form>
  );
}
