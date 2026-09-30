import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Code,
  Eraser,
  Highlighter,
  Image as ImageIcon,
  Indent,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Outdent,
  Palette,
  Quote,
  Redo,
  Smile,
  Strikethrough,
  Type,
  Underline,
  Undo,
} from "lucide-react";
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import Squire from "squire-rte";
import { sanitizeEditorFragment } from "@/lib/html";
import { t as translate } from "@/lib/i18n";
import { Popover, useMenu } from "@/ui/popover";

export interface RichEditorHandle {
  focus(): void;
  insertHtml(html: string): void;
  insertText(text: string): void;
  getHtml(): string;
}

interface Props {
  html: string;
  onChange: (html: string) => void;
  placeholder?: string;
  spellcheck?: boolean;
  onFiles?: (files: File[]) => void;
  /**
   * A drop the editor took itself, so a surface that shows a drop target around
   * it can put that away. The drop stops at the editor and never reaches the
   * caller's own handler when it has files, so this is the only way it hears.
   */
  onDropHandled?: () => void;
  toolbarExtra?: ReactNode;
  showToolbar: boolean;
  autoFocus?: boolean;
  /** If provided, inserted images are uploaded and referenced by URL instead of embedded as data: URLs. */
  imageUpload?: (file: File) => Promise<string>;
}

const EMOJI =
  "😀 😃 😄 😁 😆 😅 😂 🤣 🙂 😉 😊 😇 🥰 😍 😘 😋 😜 🤪 🤗 🤔 🤫 🤐 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 👍 👎 👌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👋 🤚 🖐️ ✋ 🖖 👏 🙌 👐 🤲 🤝 🙏 💪 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 ❣️ 💕 💯 💥 🔥 ✨ 🎉 🎊 🎈 🎁 🏆 ⭐ 🌟 ☀️ 🌙 ⚡ ☕ 🍕 🍺 🚀 ✈️ 🏠 💼 📅 📎 📌 ✅ ❌ ⚠️ ❓ ❗ 💡 🔔 📧 🙈 🙉 🙊 🐱 🐶 🦊 🐼".split(
    " ",
  );
const COLORS = [
  "#000000",
  "#434343",
  "#666666",
  "#999999",
  "#b7b7b7",
  "#cccccc",
  "#d9d9d9",
  "#ffffff",
  "#980000",
  "#ff0000",
  "#ff9900",
  "#ffff00",
  "#00ff00",
  "#00ffff",
  "#4a86e8",
  "#0000ff",
  "#9900ff",
  "#ff00ff",
  "#e6b8af",
  "#f4cccc",
  "#fce5cd",
  "#fff2cc",
  "#d9ead3",
  "#d0e0e3",
  "#c9daf8",
  "#cfe2f3",
  "#d9d2e9",
  "#ead1dc",
  "#cc4125",
  "#e06666",
  "#f6b26b",
  "#ffd966",
  "#93c47d",
  "#76a5af",
  "#6d9eeb",
  "#6fa8dc",
  "#8e7cc3",
  "#c27ba0",
  "#a61c00",
  "#cc0000",
  "#e69138",
  "#f1c232",
  "#6aa84f",
  "#45818e",
  "#3c78d8",
  "#3d85c6",
  "#674ea7",
  "#a64d79",
];

/*
 * The editor is Squire, an HTML editor built for email: the HTML is the source
 * of truth, which is what lets a quote or a forward keep a third party's markup
 * intact, and quoting is a first-class operation (`increaseQuoteLevel`). Squire
 * normalises the browsers itself and does not use `document.execCommand`, so
 * the toolbar buttons below drive its own methods and its own undo stack rather
 * than browser editing commands.
 *
 * The toolbar, the popovers and the CSS classes are the app's own and are
 * unchanged: Squire brings no UI, so it is a component dropped where a
 * `<textarea>` would be.
 */
export const RichEditor = forwardRef<RichEditorHandle, Props>(function RichEditor(
  {
    html,
    onChange,
    placeholder,
    spellcheck = true,
    onFiles,
    onDropHandled,
    toolbarExtra,
    showToolbar,
    autoFocus,
    imageUpload,
  },
  ref,
) {
  const elRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Squire | null>(null);
  const lastEmitted = useRef<string>("");
  const htmlRef = useRef(html);
  htmlRef.current = html;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [empty, setEmpty] = useState(!html);
  const [undo, setUndo] = useState({ canUndo: false, canRedo: false });
  const emojiMenu = useMenu();
  const colorMenu = useMenu();
  const hiliteMenu = useMenu();
  const linkMenu = useMenu();
  const [linkUrl, setLinkUrl] = useState("");

  /** Read the editor back out and hand it to the caller, when it changed. */
  const emit = useCallback(() => {
    const editor = editorRef.current;
    const el = elRef.current;
    if (!editor || !el) return;
    const value = editor.getHTML();
    lastEmitted.current = value;
    setEmpty(!el.textContent?.trim() && !el.querySelector("img"));
    onChangeRef.current(value);
  }, []);

  const insertImageFile = useCallback(
    (file: File) => {
      const place = (url: string) => {
        const editor = editorRef.current;
        if (!editor) return;
        editor.focus();
        editor.insertImage(url, { alt: file.name, style: "max-width:100%" });
        emit();
      };
      if (imageUpload) {
        imageUpload(file)
          .then(place)
          .catch(() => {
            /* uploader reports its own errors */
          });
        return;
      }
      const reader = new FileReader();
      reader.onload = () => place(String(reader.result));
      reader.readAsDataURL(file);
    },
    [imageUpload, emit],
  );

  /* The engine is created once and lives for the mount: the effect that builds
     it names no changing value, so a re-render never tears it down and the undo
     stack survives. */
  const insertImageRef = useRef(insertImageFile);
  insertImageRef.current = insertImageFile;

  // autoFocus means "focus on mount", as it does on a DOM element. Reacting to
  // the prop turning true later would yank the caret out of whatever the user
  // is typing in — typing the first letter of a subject would jump to the body.
  const autoFocusOnMount = useRef(autoFocus);
  const caretPlaced = useRef(false);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const editor = new Squire(el, {
      blockTag: "DIV",
      sanitizeToDOMFragment: (input) => sanitizeEditorFragment(input),
    });
    editorRef.current = editor;
    /* Seed this instance from the current html. The sync effect below fires on
       a prop change, and under StrictMode the engine is built twice in one
       commit: a ref that survives the first teardown would make the second,
       empty instance look already in sync, and a pre-filled body (a reply, a
       template, a signature) would come up blank. The empty body is left to the
       sync effect so the caret logic below can still place it in the body's
       first line once that body arrives. */
    if (htmlRef.current) {
      editor.setHTML(htmlRef.current);
      lastEmitted.current = htmlRef.current;
      setEmpty(!el.textContent?.trim() && !el.querySelector("img"));
      setUndo({ canUndo: false, canRedo: false });
    }

    const onInput = () => emit();
    const onUndoState = (event: Event) => {
      const detail = (event as CustomEvent<{ canUndo: boolean; canRedo: boolean }>)
        .detail;
      setUndo({ canUndo: detail.canUndo, canRedo: detail.canRedo });
    };
    /* An image pasted from the clipboard arrives as its own event, after the
       engine has already swallowed the paste: the image is uploaded and put in
       through `insertImage`, so the src is set as a property and never built
       into markup. */
    const onPasteImage = (event: Event) => {
      const { clipboardData } = (event as CustomEvent<{ clipboardData: DataTransfer }>)
        .detail;
      const file = Array.from(clipboardData?.items ?? [])
        .find((item) => item.type.startsWith("image/"))
        ?.getAsFile();
      if (file) insertImageRef.current(file);
    };
    editor.addEventListener("input", onInput);
    editor.addEventListener("undoStateChange", onUndoState);
    editor.addEventListener("pasteImage", onPasteImage);
    if (autoFocusOnMount.current) editor.focus();
    return () => {
      editor.removeEventListener("input", onInput);
      editor.removeEventListener("undoStateChange", onUndoState);
      editor.removeEventListener("pasteImage", onPasteImage);
      editor.destroy();
      editorRef.current = null;
      caretPlaced.current = false;
    };
  }, [emit]);

  // Sync external html → DOM (only when it differs from what we emitted).
  useEffect(() => {
    const editor = editorRef.current;
    const el = elRef.current;
    if (!editor || !el) return;
    if (html !== lastEmitted.current) {
      editor.setHTML(html);
      lastEmitted.current = html;
      setEmpty(!el.textContent?.trim() && !el.querySelector("img"));
      // setHTML clears the engine's undo stack without firing undoStateChange,
      // so the buttons have to be told the history is gone.
      setUndo({ canUndo: false, canRedo: false });
    }
  }, [html]);

  /*
   * The caret, once the body is there, at the start of its first block.
   *
   * The body can arrive after the editor does -- a reply's quote is fetched --
   * and a caret placed while the root is still empty sits in a DOM that is then
   * replaced, which leaves the browser to decide where the character typed next
   * lands. That is the browser's own normalisation and not a position this
   * client chose, and the first line of a message is the last line to leave to
   * it: the body opens with an empty line that is the reader's, and everything
   * below it belongs to the signature and the quote, which are drawn in another
   * colour. Placing the caret inside the first block is the position every
   * browser types into the same way.
   */
  useEffect(() => {
    if (!autoFocusOnMount.current || caretPlaced.current) return;
    const editor = editorRef.current;
    const el = elRef.current;
    if (!editor || !el?.firstChild) return;
    caretPlaced.current = true;
    editor.focus();
    editor.moveCursorToStart();
  }, [html]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => editorRef.current?.focus(),
      insertHtml: (h: string) => {
        const editor = editorRef.current;
        if (!editor) return;
        editor.focus();
        editor.insertHTML(h);
        emit();
      },
      insertText: (text: string) => {
        const editor = editorRef.current;
        if (!editor) return;
        editor.focus();
        editor.insertPlainText(text, false);
        emit();
      },
      getHtml: () => editorRef.current?.getHTML() ?? "",
    }),
    [emit],
  );

  /** Focus the editor (Squire restores the saved selection), run a command, report. */
  const run = useCallback(
    (command: (editor: Squire) => void) => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      command(editor);
      emit();
    },
    [emit],
  );

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    /*
     * The editor is the innermost drop target, so it owns the drop: what the
     * caret is over is what decides. Both things it can do stay here -- an
     * image goes into the body, anything else is attached through `onFiles` --
     * and the event stops, because the composer around it attaches every file
     * it is handed: dropping a PDF here attached it twice, once from each.
     *
     * `onDropHandled` is how the composer hears that the drop is over. It is
     * the element drawing the drop highlight, and a drop that never reaches
     * its own handler would leave that highlight on for good.
     */
    e.preventDefault();
    e.stopPropagation();
    onDropHandled?.();
    const images = files.filter((f) => f.type.startsWith("image/"));
    const others = files.filter((f) => !f.type.startsWith("image/"));
    images.forEach(insertImageFile);
    if (others.length) onFiles?.(others);
  };

  const applyLink = () => {
    const url = linkUrl.trim();
    linkMenu.close();
    if (!url) return;
    /* A scheme this composer will not link, so the text typed into the box
       becomes a URL rather than being taken at its word. The href itself is
       set on the anchor by the engine, never built into markup, so nothing a
       URL carries can leave the attribute. */
    const typed = /^(https?:|mailto:|tel:)/i.test(url) ? url : `https://${url}`;
    run((editor) => editor.makeLink(typed, { target: "_blank", rel: "noopener" }));
    setLinkUrl("");
  };

  return (
    <div className="composer-editor">
      <div
        ref={elRef}
        className="editor-area"
        contentEditable
        suppressContentEditableWarning
        spellCheck={spellcheck}
        data-placeholder={placeholder ?? ""}
        data-empty={empty}
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
            e.preventDefault();
            linkMenu.open(e.currentTarget);
          }
          if (e.key === "Tab") {
            e.preventDefault();
            run((editor) =>
              e.shiftKey ? editor.decreaseListLevel() : editor.increaseListLevel(),
            );
          }
        }}
        role="textbox"
        aria-multiline="true"
        aria-label={translate("Message body")}
      />
      {showToolbar && (
        <div
          className="editor-toolbar"
          role="toolbar"
          aria-label={translate("Formatting")}
        >
          <button
            type="button"
            className="icon-btn"
            disabled={!undo.canUndo}
            title={translate("Undo (Ctrl+Z)")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run((editor) => editor.undo())}
          >
            <Undo size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            disabled={!undo.canRedo}
            title={translate("Redo")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run((editor) => editor.redo())}
          >
            <Redo size={16} />
          </button>
          <span className="tb-sep" />
          <select
            title={translate("Font size")}
            onChange={(e) => {
              const size = e.target.value;
              e.target.value = "";
              run((editor) => editor.setFontSize(size));
            }}
            defaultValue=""
          >
            <option value="" disabled>
              {translate("Size")}
            </option>
            <option value="small">{translate("Small")}</option>
            <option value="medium">{translate("Normal")}</option>
            <option value="large">{translate("Large")}</option>
            <option value="xx-large">{translate("Huge")}</option>
          </select>
          <button
            type="button"
            className="icon-btn"
            title={translate("Bold (Ctrl+B)")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run((editor) => editor.bold())}
          >
            <Bold size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={translate("Italic (Ctrl+I)")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run((editor) => editor.italic())}
          >
            <Italic size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={translate("Underline (Ctrl+U)")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run((editor) => editor.underline())}
          >
            <Underline size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={translate("Strikethrough")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run((editor) => editor.strikethrough())}
          >
            <Strikethrough size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={translate("Text color")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={colorMenu.open}
          >
            <Palette size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={translate("Highlight")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={hiliteMenu.open}
          >
            <Highlighter size={16} />
          </button>
          <span className="tb-sep" />
          <button
            type="button"
            className="icon-btn"
            title={translate("Align left")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run((editor) => editor.setTextAlignment("left"))}
          >
            <AlignLeft size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={translate("Center")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run((editor) => editor.setTextAlignment("center"))}
          >
            <AlignCenter size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={translate("Align right")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run((editor) => editor.setTextAlignment("right"))}
          >
            <AlignRight size={16} />
          </button>
          <span className="tb-sep" />
          <button
            type="button"
            className="icon-btn"
            title={translate("Bulleted list")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run((editor) => editor.makeUnorderedList())}
          >
            <List size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={translate("Numbered list")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run((editor) => editor.makeOrderedList())}
          >
            <ListOrdered size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={translate("Decrease indent")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run((editor) => editor.decreaseListLevel())}
          >
            <Outdent size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={translate("Increase indent")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run((editor) => editor.increaseListLevel())}
          >
            <Indent size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={translate("Quote")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run((editor) => editor.increaseQuoteLevel())}
          >
            <Quote size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={translate("Code block")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run((editor) => editor.toggleCode())}
          >
            <Code size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={translate("Normal text")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() =>
              run((editor) => {
                editor.removeQuote();
                editor.removeCode();
                editor.removeList();
              })
            }
          >
            <Type size={16} />
          </button>
          <span className="tb-sep" />
          <button
            type="button"
            className="icon-btn"
            title={translate("Insert link (Ctrl+K)")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={linkMenu.open}
          >
            <LinkIcon size={16} />
          </button>
          <label
            className="icon-btn"
            title={translate("Insert image")}
            onMouseDown={(e) => e.preventDefault()}
          >
            <ImageIcon size={16} />
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) insertImageFile(f);
                e.target.value = "";
              }}
            />
          </label>
          <button
            type="button"
            className="icon-btn"
            title={translate("Emoji")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={emojiMenu.open}
          >
            <Smile size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={translate("Remove formatting")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() =>
              run((editor) => {
                editor.removeAllFormatting();
                editor.removeLink();
              })
            }
          >
            <Eraser size={16} />
          </button>
          {toolbarExtra}
        </div>
      )}
      <Popover
        anchor={emojiMenu.anchor}
        onClose={emojiMenu.close}
        trigger={emojiMenu.trigger}
        side="top"
        closeOnClick={false}
        width={290}
      >
        <div className="emoji-grid">
          {EMOJI.map((e) => (
            <button
              key={e}
              type="button"
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => {
                run((editor) => editor.insertPlainText(e, false));
                emojiMenu.close();
              }}
            >
              {e}
            </button>
          ))}
        </div>
      </Popover>
      <Popover
        anchor={colorMenu.anchor}
        onClose={colorMenu.close}
        trigger={colorMenu.trigger}
        side="top"
        closeOnClick={false}
        width={230}
      >
        <div className="color-grid">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              style={{ background: c }}
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => {
                run((editor) => editor.setTextColor(c));
                colorMenu.close();
              }}
              aria-label={c}
            />
          ))}
        </div>
      </Popover>
      <Popover
        anchor={hiliteMenu.anchor}
        onClose={hiliteMenu.close}
        trigger={hiliteMenu.trigger}
        side="top"
        closeOnClick={false}
        width={230}
      >
        <div className="color-grid">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              style={{ background: c }}
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => {
                run((editor) => editor.setHighlightColor(c));
                hiliteMenu.close();
              }}
              aria-label={c}
            />
          ))}
        </div>
      </Popover>
      <Popover
        anchor={linkMenu.anchor}
        onClose={linkMenu.close}
        trigger={linkMenu.trigger}
        side="top"
        closeOnClick={false}
        width={320}
      >
        <form
          className="link-popup"
          onSubmit={(e) => {
            e.preventDefault();
            applyLink();
          }}
        >
          <input
            className="input sm"
            placeholder={translate("https://…")}
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
          />
          <button type="submit" className="btn btn-sm btn-primary">
            {translate("Link")}
          </button>
        </form>
      </Popover>
    </div>
  );
});
