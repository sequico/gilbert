import { errorMessage } from "@gilbert/shared/errors";
import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import {
  fetchInstallation,
  installationModel,
  publishInstallation,
} from "@/lib/installationAdmin";
import { jsonProblem } from "@/ui/JsonDocumentEditor";
import { ModelFields } from "@/views/admin/installation/ModelFields";
import { type KeyDraft, withModelKey } from "@/views/admin/installation/modelDocument";

/**
 * The model, as fields that write `agent.provider` into the installation's
 * document.
 *
 * The document is the one home (ADR 0031) and the Installation page edits the
 * whole of it; this section is the same text seen through the two fields an
 * administrator chooses, and the key — write-only, held here and stated only as
 * the publish is sent.
 */
export function AgentModel({ onSaved }: { onSaved: () => void }) {
  const [text, setText] = useState("");
  const [keyDraft, setKeyDraft] = useState<KeyDraft>({ kind: "kept" });
  const [present, setPresent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchInstallation()
      .then((installation) => {
        if (!live) return;
        setPresent(installation.present);
        setText(installation.document ?? "");
      })
      .catch((err) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, []);

  async function save() {
    if (saving) return;
    /*
     * A key belongs to a model: with no provider named there is nothing to
     * attach it to, and the write would silently drop it. Say so rather than
     * report a save that stored nothing.
     */
    if (keyDraft.kind === "key" && !installationModel(text).provider) {
      setError(t("A key needs a provider: name one above, then save the key."));
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const outcome = await publishInstallation(withModelKey(text, keyDraft));
      setText(outcome.document);
      setKeyDraft({ kind: "kept" });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (!present) return <p className="hint">{t("No installation document yet.")}</p>;

  const model = installationModel(text);
  const editable = !saving && !jsonProblem(text);

  return (
    <section>
      <ModelFields
        text={text}
        model={model}
        documentProblem={jsonProblem(text)}
        editable={editable}
        keyDraft={keyDraft}
        onText={(next) => {
          setText(next);
          setSaved(false);
        }}
        onKeyDraft={setKeyDraft}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving}
          onClick={() => void save()}
        >
          {t("Save")}
        </button>
        {saved && <span className="hint">{t("Saved; applies at the next boot.")}</span>}
      </div>
      {error && <div className="error-box">{error}</div>}
    </section>
  );
}
