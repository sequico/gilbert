/**
 * The one Sieve-editing widget (ADR 0008): CodeMirror 6 plus
 * `@codemirror/legacy-modes`' `mode/sieve` grammar, the MIT-licensed
 * tokenizer CodeMirror has shipped for years, ported into a `StreamLanguage`
 * rather than rewritten here. Both the personal "Scripts (advanced)" editor
 * (`FiltersSettings.tsx`) and the admin **System Sieve** surface mount this,
 * so highlighting a Sieve script is one behaviour, not two.
 *
 * A controlled component: `value` is the source of truth, and an external
 * change to it (discarding an edit, opening a different script) replaces the
 * document — guarded by a content comparison so the editor's own keystrokes,
 * echoed back through `onChange`, never bounce into a second transaction.
 */
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { sieve } from "@codemirror/legacy-modes/mode/sieve";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { type CSSProperties, useEffect, useRef } from "react";

const sieveHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--accent)", fontWeight: 600 },
  { tag: tags.atom, color: "var(--accent)" },
  { tag: tags.string, color: "var(--success)" },
  { tag: tags.comment, color: "var(--fg-muted)", fontStyle: "italic" },
  { tag: tags.variableName, color: "var(--link)" },
  { tag: tags.number, color: "var(--warn)" },
]);

const theme = EditorView.theme({
  "&": {
    color: "var(--fg)",
    backgroundColor: "var(--bg-sunken)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    fontSize: "12.5px",
  },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
    padding: "12px",
    caretColor: "var(--fg)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--bg-sunken)",
    color: "var(--fg-faint)",
    border: "none",
  },
  "&.cm-focused": { outline: "none", boxShadow: "var(--focus-ring)" },
});

export function SieveEditor({
  value,
  onChange,
  readOnly = false,
  minHeight = 240,
  autoFocus = false,
}: {
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
  minHeight?: number;
  autoFocus?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  /** Set while an external `value` is applied, so it is not echoed back as an edit. */
  const applyingExternal = useRef(false);

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      doc: value,
      parent: hostRef.current,
      extensions: [
        lineNumbers(),
        history(),
        indentOnInput(),
        bracketMatching(),
        StreamLanguage.define(sieve),
        syntaxHighlighting(sieveHighlight),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.lineWrapping,
        EditorView.editable.of(!readOnly),
        theme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !applyingExternal.current)
            onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    viewRef.current = view;
    if (autoFocus) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Mounted once: `value` after the first render is applied by the effect
    // below, and `readOnly`/`minHeight`/`autoFocus` are not expected to
    // change under an already-mounted editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    applyingExternal.current = true;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    applyingExternal.current = false;
  }, [value]);

  return (
    <div
      ref={hostRef}
      className="sieve-editor notranslate"
      translate="no"
      style={{ "--sieve-min-h": `${minHeight}px` } as CSSProperties}
    />
  );
}
