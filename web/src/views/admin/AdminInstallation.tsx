import { errorMessage } from "@gilbert/shared/errors";
import { isRecord } from "@gilbert/shared/json";
import { useEffect, useState } from "react";
import { t, tNode } from "@/lib/i18n";
import {
  fetchInstallation,
  type InstallationView,
  type InstallationPublished as Published,
  publishInstallation,
  startingInstallationDocument,
} from "@/lib/installationAdmin";
import { JsonDocumentEditor, jsonProblem } from "@/ui/JsonDocumentEditor";
import { LoadState } from "@/ui/LoadState";
import { Switch } from "@/ui/misc";

/** What the document names as the installation's model, for the form's fields. */
interface ModelDraft {
  provider: string;
  model: string;
  baseUrl: string;
}

/**
 * The three things a save can say about the model's key, which is never shown.
 *
 * `kept` is a field that says nothing: untouched, or typed into and emptied
 * again — the two are the same save, and both leave the stored key exactly as it
 * is. `none` is the operator saying the provider needs none — a model on the
 * deployment's own network — which clears the stored key. A value is the key to
 * write. The document tells the three apart by the field itself, and
 * `installationAdmin.ts` reads it that way: no `apiKey` at all, or an empty one,
 * keeps the stored key; the `null` the switch below sends says the provider
 * needs none; a value is that key.
 */
type KeyDraft = { kind: "kept" } | { kind: "none" } | { kind: "key"; value: string };

/** The text as a JSON object, or null when it is not one. */
function parseObject(text: string): Record<string, unknown> | null {
  try {
    const whole: unknown = JSON.parse(text);
    return isRecord(whole) ? whole : null;
  } catch {
    return null;
  }
}

/**
 * What the document text names as the model.
 *
 * Read leniently rather than through the document's own validator
 * (`@gilbert/shared/installation`): the text is a draft an administrator is
 * editing, not a document a boot will read, and a half-written one should still
 * show the model it names. The server validates the whole document on publish.
 */
function modelOf(text: string): ModelDraft {
  const none: ModelDraft = { provider: "", model: "", baseUrl: "" };
  const whole = parseObject(text);
  if (!whole || !isRecord(whole.agent) || !isRecord(whole.agent.provider)) return none;
  const provider = whole.agent.provider;
  return {
    provider: typeof provider.provider === "string" ? provider.provider : "",
    model: typeof provider.model === "string" ? provider.model : "",
    baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : "",
  };
}

/**
 * The document text with fields of the model's provider set.
 *
 * The text is what this surface holds and publishes, so a field changed here is
 * a change to the document and the editor below shows what was written: the
 * model has one home, not a second one beside the document. A text that is not a
 * JSON object is left exactly as it is — the fields are dead while it is — and a
 * document with no `agent` section grows one.
 */
function withModelField(
  text: string,
  patch: Partial<Record<"provider" | "model" | "baseUrl" | "apiKey", string | null>>,
): string {
  const whole = parseObject(text);
  if (!whole) return text;
  const agent = isRecord(whole.agent) ? whole.agent : {};
  const provider = isRecord(agent.provider) ? agent.provider : {};
  return JSON.stringify(
    { ...whole, agent: { ...agent, provider: { ...provider, ...patch } } },
    null,
    2,
  );
}

/**
 * The document to publish, with the key the form states.
 *
 * The key never reaches the text this surface holds — the server takes it out
 * when it reads, and the form keeps its copy in memory only — so the two things
 * a save can state are written here, once, into what is sent: a value, or `null`
 * for a provider that needs none. A field left untouched or emptied states
 * nothing, and the text goes as it is. A document that names no provider has no
 * model, and so no key to carry or to clear.
 */
function withModelKey(text: string, draft: KeyDraft): string {
  if (draft.kind === "kept") return text;
  if (!modelOf(text).provider) return text;
  return withModelField(text, { apiKey: draft.kind === "none" ? null : draft.value });
}

/**
 * The installation's own document (ADR 0011 — the installation is configured
 * once, and its configuration is a document in the account's own Files rather
 * than a container's environment).
 *
 * The policy editor beside this one publishes something that applies at once;
 * this one publishes what the *next boot* reads, and the surface says so
 * instead of reporting a save as though the running process had changed. A
 * refusal — text that is not a document, a document this build could not boot
 * from — is shown as the server stated it, because the server is the door.
 *
 * One part of the document an administrator **chooses** rather than looks up is
 * the installation's model (ADR 0031), so it has fields of its own that write
 * `agent.provider` in the text above them: one home for the model, and the
 * document is it. The key is the one thing those fields never hold — a key is
 * write-only, no read hands it back, and the field states it only as the
 * publish is sent (`withModelKey`).
 */
export function AdminInstallation() {
  const [view, setView] = useState<InstallationView | null>(null);
  const [text, setText] = useState("");
  /** What the server last held: what "unchanged" is measured against. */
  const [baseline, setBaseline] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Published | null>(null);
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  /**
   * What the form says about the model's key, held here and never written into
   * the text: a key is write-only, so the document this surface shows carries
   * none and the field is where one is stated at all.
   */
  const [keyDraft, setKeyDraft] = useState<KeyDraft>({ kind: "kept" });
  // A publish with nothing to publish is not a state the button should offer —
  // and a key stated in the form is something to publish even when the text has
  // not moved, since the key is never part of the text.
  const dirty = text !== baseline || keyDraft.kind !== "kept";

  async function load() {
    setLoadError(null);
    try {
      const current = await fetchInstallation();
      setView(current);
      if (current.document === null) {
        // Nothing is there: the editor starts from the defaults and a fresh
        // secret rather than an empty box nothing can be published from.
        setText(startingInstallationDocument());
        setBaseline("");
        setSeeded(true);
      } else {
        setText(current.document);
        setBaseline(current.document);
        setSeeded(false);
      }
      // A key the form held belongs to the read it was made from, and this one
      // is a fresh read: nothing is stated about the key until it is said again.
      setKeyDraft({ kind: "kept" });
      setLoaded(true);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function publish() {
    if (saving) return;
    setError(null);
    setNotice(null);
    const problem = jsonProblem(text);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    try {
      // The form's key is merged here and only here: it is never part of the
      // text, so nothing this surface shows ever carries it.
      const outcome = await publishInstallation(withModelKey(text, keyDraft));
      /*
       * The server hands back the document as it is now stored — the
       * validator's defaults filled in, the epoch moved on, the key taken out —
       * so the editor shows what is really there rather than what was typed,
       * and the button has nothing left to publish until the text moves again.
       */
      setText(outcome.document);
      setBaseline(outcome.document);
      setSeeded(false);
      setKeyDraft({ kind: "kept" });
      setNotice(outcome);
      setView((current) =>
        current
          ? {
              ...current,
              present: true,
              document: outcome.document,
              problem: null,
              account: outcome.account,
              master: outcome.master,
              location: outcome.location,
            }
          : current,
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) {
    return (
      <div>
        <h1>{t("Installation document")}</h1>
        <LoadState loadError={loadError} reload={() => void load()} loading={!loaded} />
      </div>
    );
  }

  const documentProblem = jsonProblem(text);
  /** The fields write into the text, so they need a text that is one object. */
  const editable = !saving && !documentProblem;
  const model = modelOf(text);

  return (
    <div>
      <h1>{t("Installation document")}</h1>
      <p className="lead">
        {t(
          "The configuration this installation runs on: one JSON document in the Master's own Files — the account this installation signs in as, which the server reads once at boot. What you publish here is what the next boot runs on, and the process running now keeps what it booted with.",
        )}
      </p>
      {view && <p className="hint">{t("Stored at {where}", { where: view.location })}</p>}
      {seeded && (
        <p className="hint">
          {t(
            "The installation's own account holds no document yet, so the editor starts from the installation's defaults and a freshly generated app secret. Publish it as it stands, or edit it first.",
          )}
        </p>
      )}
      {view?.problem && (
        <div className="error-box">
          {t("A boot would refuse the stored document: {reason}", {
            reason: view.problem,
          })}
        </div>
      )}
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
            onChange={(e) => setText(withModelField(text, { provider: e.target.value }))}
          />
        </div>
        <div className="field">
          <label htmlFor="model-name">{t("Model")}</label>
          <input
            id="model-name"
            className="input"
            value={model.model}
            disabled={!editable}
            onChange={(e) => setText(withModelField(text, { model: e.target.value }))}
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
          onChange={(e) => setText(withModelField(text, { baseUrl: e.target.value }))}
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
            setKeyDraft(
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
        onChange={(on) => setKeyDraft(on ? { kind: "none" } : { kind: "kept" })}
        label={t("This provider needs no key")}
      />
      <p className="hint">
        {tNode(
          "The {field} field is the app secret every stored session is sealed with: anyone who can read this page can read it, and a publish that loses it would sign everyone out. Keep it in the document it belongs to.",
          { field: <code>secret</code> },
        )}
      </p>
      <JsonDocumentEditor
        label={t("Installation document")}
        value={text}
        onChange={setText}
        saving={saving}
        dirty={dirty}
        action={t("Publish document")}
        busy={t("Publishing…")}
        onAction={() => void publish()}
        minHeight="24rem"
        secondary={
          <button className="btn btn-ghost" disabled={saving} onClick={() => void load()}>
            {t("Reload")}
          </button>
        }
        notice={
          notice && (
            <>
              <strong>{t("Takes effect at the next boot.")}</strong> {notice.message}
            </>
          )
        }
        error={error}
      />
    </div>
  );
}
