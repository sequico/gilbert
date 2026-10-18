import { errorMessage } from "@gilbert/shared/errors";
import { useEffect, useState } from "react";
import { t, tNode } from "@/lib/i18n";
import {
  fetchInstallation,
  type InstallationView,
  installationModel,
  type InstallationPublished as Published,
  publishInstallation,
  startingInstallationDocument,
} from "@/lib/installationAdmin";
import { JsonDocumentEditor, jsonProblem } from "@/ui/JsonDocumentEditor";
import { LoadState } from "@/ui/LoadState";
import { ModelFields } from "./installation/ModelFields";
import {
  type KeyDraft,
  withInstructionField,
  withModelKey,
} from "./installation/modelFields";

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
  const model = installationModel(text);

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
      <ModelFields
        text={text}
        model={model}
        documentProblem={documentProblem}
        editable={editable}
        keyDraft={keyDraft}
        onText={setText}
        onKeyDraft={setKeyDraft}
      />
      <h2 style={{ marginTop: 24 }}>{t("The installation's line")}</h2>
      <p className="hint">
        {t(
          "The outermost prose the agent is told, above each group's own instruction: how this installation wants it to work, in one paragraph. Publishing applies at the next pass.",
        )}
      </p>
      <div className="field">
        <label htmlFor="agent-instruction">{t("Standing instruction")}</label>
        <textarea
          id="agent-instruction"
          rows={4}
          className="input"
          value={model.instruction}
          disabled={!editable}
          onChange={(e) => setText(withInstructionField(text, e.target.value))}
        />
      </div>
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
