import { t } from "@/lib/i18n";
import type { InstallationFields } from "@/lib/installationAdmin";
import { Switch } from "@/ui/misc";
import { type KeyDraft, withModelField } from "./modelDocument";

/**
 * The installation's model, as fields that write into the document.
 *
 * The document is the one home (ADR 0031): every field here rewrites
 * `agent.provider` in the text the page holds, and the page is what publishes.
 * The key is the exception it has always been -- write-only, held by the page
 * and stated only as the publish is sent -- so the field and its switch report
 * the draft upwards and never carry the key back down.
 */
export function ModelFields({
  text,
  model,
  documentProblem,
  editable,
  keyDraft,
  onText,
  onKeyDraft,
}: {
  text: string;
  model: InstallationFields;
  documentProblem: string | null;
  editable: boolean;
  keyDraft: KeyDraft;
  onText: (text: string) => void;
  onKeyDraft: (draft: KeyDraft) => void;
}) {
  return (
    <>
      {/*
       * The model is the one part of this document an administrator chooses
       * rather than looks up (ADR 0031), so it gets fields of its own instead of
       * being JSON nobody can find. They are not a second home for it: what they
       * write is the document below, `agent.provider` and nothing else.
       */}
      <h2 style={{ marginTop: 24 }}>{t("The installation's model")}</h2>
      <p className="hint">
        {t(
          "One model serves the whole installation — every call the agent makes runs on it — and the document below is where it is named. Publishing applies at the next boot.",
        )}
      </p>
      {documentProblem && <p className="hint">{documentProblem}</p>}
      {!model.provider && (
        <p className="hint">
          {t(
            "No model is named, so this installation has no agent: it stays idle and says so in the server's log.",
          )}
        </p>
      )}
      <div className="field-row">
        <div className="field">
          <label htmlFor="model-provider">{t("Provider")}</label>
          <input
            id="model-provider"
            className="input"
            value={model.provider}
            disabled={!editable}
            onChange={(e) => onText(withModelField(text, { provider: e.target.value }))}
          />
        </div>
        <div className="field">
          <label htmlFor="model-name">{t("Model")}</label>
          <input
            id="model-name"
            className="input"
            value={model.model}
            disabled={!editable}
            onChange={(e) => onText(withModelField(text, { model: e.target.value }))}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="model-base-url">{t("Base URL")}</label>
        <input
          id="model-base-url"
          className="input"
          value={model.baseUrl}
          disabled={!editable}
          placeholder={t("https://api.openai.com/v1")}
          onChange={(e) => onText(withModelField(text, { baseUrl: e.target.value }))}
        />
      </div>
      <div className="field">
        <label htmlFor="model-key">{t("API key")}</label>
        <input
          id="model-key"
          className="input"
          type="password"
          /* Never filled from the document: no read hands the stored key back. */
          value={keyDraft.kind === "key" ? keyDraft.value : ""}
          disabled={!editable || keyDraft.kind === "none" || !model.provider}
          placeholder={t("Stored on the server")}
          onChange={(e) =>
            onKeyDraft(
              // Emptying the field says nothing about the key, exactly as never
              // typing into it does: the stored one stands. The switch is the
              // one thing that clears it.
              e.target.value ? { kind: "key", value: e.target.value } : { kind: "kept" },
            )
          }
        />
        <span className="hint">
          {t(
            "The key is write-only: no read hands it back, so this field is empty and every answer carries none of it. An untouched or emptied field keeps the stored key, a value replaces it, and the switch below — for a provider that needs no key, a model on this deployment's own network, say — clears it. A document that names no model carries no key.",
          )}
        </span>
      </div>
      <Switch
        checked={keyDraft.kind === "none"}
        disabled={!editable || !model.provider}
        onChange={(on) => onKeyDraft(on ? { kind: "none" } : { kind: "kept" })}
        label={t("This provider needs no key")}
      />
    </>
  );
}
