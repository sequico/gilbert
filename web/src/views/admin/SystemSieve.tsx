/**
 * System Sieve (ADR 0008): the admin editor for Stalwart's own trusted,
 * server-wide Sieve scripts — `x:SieveSystemScript`, not an account's own
 * script (that is `ScriptsEditor` in `../settings/FiltersSettings.tsx`,
 * which this view's list/edit shape deliberately mirrors). More than one
 * script can be active at once, unlike a person's own filters: each is
 * invoked by name from Stalwart's own configuration, which this surface does
 * not manage.
 *
 * Stalwart compiles the script on save (`x:SieveSystemScript/set`); there is
 * no separate validate call for a system script the way there is for a
 * personal one, so a bad script surfaces as a save error rather than a
 * preflight check.
 */
import { AlertTriangle, Plus, Power, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  deleteSystemSieveScript,
  getSystemSieveScript,
  listSystemSieveScripts,
  type SystemSieveScript,
  saveSystemSieveScript,
  setSystemSieveScriptActive,
} from "@/lib/adminSieve";
import { t } from "@/lib/i18n";
import { useUnsavedChanges } from "@/lib/unsavedChanges";
import { confirmDialog } from "@/ui/dialog";
import { Spinner } from "@/ui/misc";
import { SieveEditor } from "@/ui/SieveEditor";
import { toast } from "@/ui/toast";

interface Opened {
  name: string;
  description: string;
  content: string;
}

export function SystemSieve() {
  const [scripts, setScripts] = useState<SystemSieveScript[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sel, setSel] = useState<SystemSieveScript | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [opened, setOpened] = useState<Opened | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty =
    opened !== null &&
    (name !== opened.name ||
      description !== opened.description ||
      content !== opened.content);

  async function load() {
    setLoadError(null);
    try {
      setScripts(await listSystemSieveScripts());
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const start = (script: SystemSieveScript | null, source: string) => {
    setSel(script);
    setName(script?.name ?? "");
    setDescription(script?.description ?? "");
    setContent(source);
    setOpened({
      name: script?.name ?? "",
      description: script?.description ?? "",
      content: source,
    });
  };

  const close = () => {
    setSel(null);
    setName("");
    setDescription("");
    setContent("");
    setOpened(null);
  };

  const open = async (script: SystemSieveScript | null) => {
    if (!script) {
      start(null, 'require ["fileinto"];\n\n');
      return;
    }
    try {
      const full = await getSystemSieveScript(script.id);
      start(script, full.contents);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const save = async (activate: boolean): Promise<boolean> => {
    if (!name.trim()) {
      toast.error(t("Script name is required"));
      return false;
    }
    setBusy(true);
    try {
      await saveSystemSieveScript(sel?.id ?? null, {
        name: name.trim(),
        description: description.trim() || null,
        contents: content,
        activate,
      });
      toast.success(t("System script saved"));
      close();
      await load();
      return true;
    } catch (err) {
      toast.error((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  // A hand-written system script is the worst thing here to lose, and
  // leaving the page would take it without asking — the same guard the
  // personal script editor registers for itself.
  useUnsavedChanges({
    dirty,
    message: t("Your system Sieve script has changes that have not been saved."),
    save: () => save(sel?.isActive ?? false),
    discard: close,
  });

  if (loadError) {
    return (
      <div className="warn-box">
        <div className="row gap-8" style={{ marginBottom: 8 }}>
          <AlertTriangle size={18} /> <b>{t("Could not load system Sieve scripts.")}</b>
        </div>
        <p style={{ margin: "0 0 8px" }}>{loadError}</p>
        <button className="btn" onClick={() => void load()}>
          {t("Retry")}
        </button>
      </div>
    );
  }

  if (!scripts) return <Spinner />;

  if (opened !== null) {
    return (
      <div>
        <div className="field">
          <label>{t("Script name")}</label>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={Boolean(sel)}
          />
        </div>
        <div className="field">
          <label>{t("Description")}</label>
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="field">
          <label>{t("Sieve source")}</label>
          <SieveEditor value={content} onChange={setContent} minHeight={320} />
        </div>
        <div className="row save-bar">
          <button className="btn btn-ghost" onClick={close}>
            {t("Cancel")}
          </button>
          <span className="spacer" />
          {dirty && <span className="unsaved">{t("Unsaved changes")}</span>}
          <button
            className="btn"
            disabled={busy}
            onClick={() => void save(sel?.isActive ?? false)}
          >
            {t("Save")}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void save(true)}
          >
            {t("Save & activate")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <p className="hint">
        {t(
          "Trusted, server-wide Sieve scripts Stalwart runs for the whole installation — not a person's own filters. More than one can be active at once; each is invoked by name from Stalwart's own configuration.",
        )}
      </p>
      {scripts.length === 0 && (
        <div className="empty" style={{ padding: 32 }}>
          <h3>{t("No system scripts yet")}</h3>
        </div>
      )}
      {scripts.map((s) => (
        <div key={s.id} className="card">
          <div className="card-head">
            <h3>
              <span>{s.name} </span>
              {s.isActive && (
                <span className="tag" style={{ background: "var(--success)" }}>
                  {t("active")}
                </span>
              )}
            </h3>
            <button className="btn btn-sm" onClick={() => void open(s)}>
              {t("Edit")}
            </button>
            <button
              className="btn btn-sm"
              onClick={async () => {
                try {
                  await setSystemSieveScriptActive(s.id, !s.isActive);
                  await load();
                } catch (err) {
                  toast.error((err as Error).message);
                }
              }}
            >
              <Power size={14} /> {s.isActive ? t("Deactivate") : t("Activate")}
            </button>
            <button
              className="icon-btn sm danger"
              aria-label={t("Delete script")}
              onClick={async () => {
                if (
                  await confirmDialog({
                    title: t("Delete script “{name}”?", { name: s.name }),
                    confirmLabel: t("Delete"),
                    danger: true,
                  })
                ) {
                  try {
                    await deleteSystemSieveScript(s.id);
                    await load();
                  } catch (err) {
                    toast.error((err as Error).message);
                  }
                }
              }}
            >
              <Trash2 size={16} />
            </button>
          </div>
          {s.description && <p className="hint">{s.description}</p>}
        </div>
      ))}
      <div className="row save-bar">
        <button className="btn" onClick={() => void open(null)}>
          <Plus size={16} /> {t("New script")}
        </button>
      </div>
    </div>
  );
}
