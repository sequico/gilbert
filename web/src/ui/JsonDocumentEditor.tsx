import type { ReactNode } from "react";
import { t } from "@/lib/i18n";

/**
 * The JSON document editor the two administration surfaces share.
 *
 * Both of them edit one whole document as text and publish it: the
 * installation's configuration (`AdminInstallation.tsx`) and the
 * installation-wide policy (`AdminPolicy.tsx`), and the field, the button row,
 * the notice and error boxes and the "that is not valid JSON" pre-check are one
 * piece of code rather than two: two copies of a form drift in the details that
 * are not a decision — the height of the box, the order of the sentence and the
 * request — and neither copy then says which of the two is meant.
 *
 * What is *not* shared is what genuinely differs: where the document comes
 * from, what publishing it does, and what the surface says about it — the
 * installation's "takes effect at the next boot" and the policy's publish
 * notice. Each view keeps those and hands this component the field, the buttons
 * and the boxes.
 */
export interface JsonDocumentEditorProps {
  /** How the field is announced; each surface names its own document. */
  label: string;
  /** The document as the editor holds it, unchanged. */
  value: string;
  onChange: (text: string) => void;
  /** A write is in flight: the field and the buttons go dead until it answers. */
  saving: boolean;
  /** The text differs from what the server holds, so there is something to publish. */
  dirty: boolean;
  /** The primary action's name, what it is called while it runs, and what it does. */
  action: string;
  busy: string;
  onAction: () => void;
  /**
   * Whatever else this surface offers beside the action — the installation's
   * reload, the policy's example — disabled with the rest while a write runs.
   */
  secondary?: ReactNode;
  /** How tall the box is: the installation's document is the longer of the two. */
  minHeight?: string;
  /** What the surface says about what just happened. */
  notice?: ReactNode;
  /** Why the last action did not happen. */
  error?: string | null;
}

export function JsonDocumentEditor({
  label,
  value,
  onChange,
  saving,
  dirty,
  action,
  busy,
  onAction,
  secondary,
  minHeight = "18rem",
  notice,
  error,
}: JsonDocumentEditorProps) {
  return (
    <>
      <textarea
        className="textarea"
        aria-label={label}
        spellCheck={false}
        disabled={saving}
        style={{ minHeight, fontFamily: "var(--font-mono, monospace)" }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12 }}>
        <button
          className="btn btn-primary"
          disabled={saving || !dirty}
          onClick={onAction}
        >
          {saving ? busy : action}
        </button>
        {secondary}
      </div>
      {notice && (
        <div className="hint" style={{ marginTop: 12 }}>
          {notice}
        </div>
      )}
      {error && (
        <div className="error-box" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
    </>
  );
}

/**
 * Whether this text is a document at all, and the sentence to show if it is not.
 *
 * Both surfaces check before publishing — an unparseable body is a round trip
 * the server would answer with a parse error about a request rather than about
 * the document — and both say the same thing, which is what this is here for:
 * one sentence, in one place, so the two surfaces cannot come to describe the
 * same mistake differently.
 */
export function jsonProblem(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch {
    return t("That is not valid JSON — fix the document and publish again.");
  }
}
