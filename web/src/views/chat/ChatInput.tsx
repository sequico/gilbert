/**
 * The chat composer input: a contenteditable that draws emoticons as the
 * bundled Twemoji images while the message itself stays plain text.
 *
 * A <textarea> cannot show images -- its glyphs come from the OS font, so on
 * a machine without a colour emoji font the emoticons you are typing are
 * monochrome. This editor renders the text with the same images the picker
 * and the bubbles use (web/src/lib/emoji.ts), WhatsApp style, while the
 * store keeps the plain text (ADR 0006: emoticons are text). The DOM is
 * rebuilt only when the plain text changes from outside (picker insert,
 * conversation switch, send); typing edits the DOM directly and only syncs
 * the plain text back out.
 *
 * Mentions are chips: typing `@` opens a menu over the addresses that may be
 * mentioned, picking one inserts a chip that shows the short localpart
 * (`@sam`) while the underlying plain text keeps the full address. The
 * structured mention list is derived from the text at send time
 * (web/src/lib/chat.ts), so the editor never keeps a second copy of who was
 * mentioned.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { mentionRegex, shortName } from "@/lib/chat";
import { emojiAsset } from "@/lib/emoji";
import { t } from "@/lib/i18n";

export interface ChatInputHandle {
  /** Insert an emoticon (plain text) at the caret and keep it in view. */
  insertEmoji(emoji: string): void;
  focus(): void;
}

interface ChatInputProps {
  value: string;
  placeholder: string;
  maxLength: number;
  /** Addresses the reader may mention, for the `@` menu. */
  mentionables?: string[];
  onChange(text: string): void;
  onSend(): void;
}

/** The plain text a contenteditable holds: text nodes, <img alt>, chips, <br>. */
function serializePlain(root: HTMLElement): string {
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
      return;
    }
    if (node instanceof HTMLImageElement) {
      out += node.alt;
      return;
    }
    if (node instanceof HTMLBRElement) {
      out += "\n";
      return;
    }
    if (node instanceof HTMLElement) {
      if (node.dataset.address !== undefined) {
        out += `@${node.dataset.address}`;
        return;
      }
      for (const c of node.childNodes) walk(c);
      if (node.tagName === "DIV" || node.tagName === "P") out += "\n";
    }
  };
  for (const c of root.childNodes) walk(c);
  return out;
}

/** The grapheme clusters of a string, for stable per-character rendering. */
function graphemes(text: string): string[] {
  try {
    return [
      ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    ].map((s) => s.segment);
  } catch {
    return [text];
  }
}

/** Render plain text into the editor: mention chips, <br>, emoji as images. */
function buildRich(root: HTMLElement, text: string, addresses: string[]): void {
  root.textContent = "";
  const frag = document.createDocumentFragment();
  const parts = text.split(mentionRegex(addresses));
  const appendPlain = (plain: string) => {
    for (const seg of graphemes(plain)) {
      if (seg === "\n") {
        frag.append(document.createElement("br"));
        continue;
      }
      const src = emojiAsset(seg);
      if (src) {
        const img = document.createElement("img");
        img.src = src;
        img.alt = seg;
        img.className = "chat-emoji-img";
        img.draggable = false;
        frag.append(img);
        continue;
      }
      frag.append(document.createTextNode(seg));
    }
  };
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const chip = document.createElement("span");
      chip.className = "chat-mention-chip";
      chip.contentEditable = "false";
      chip.dataset.address = part;
      chip.textContent = `@${shortName(part)}`;
      frag.append(chip);
    } else {
      appendPlain(part);
    }
  });
  root.append(frag);
}

/** The plain-text offset of the collapsed selection inside the editor. */
function caretOffsetOf(root: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return serializePlain(root).length;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return serializePlain(root).length;
  let length = 0;
  let stop = false;
  const visit = (node: Node) => {
    if (stop) return;
    if (node === range.startContainer) {
      length += range.startOffset;
      stop = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) length += node.textContent?.length ?? 0;
    else if (node instanceof HTMLImageElement) length += 1;
    else if (node instanceof HTMLBRElement) length += 1;
    else if (node instanceof HTMLElement && node.dataset.address !== undefined)
      length += 1 + node.dataset.address.length;
    else if (node instanceof HTMLElement) {
      for (const c of node.childNodes) visit(c);
      if (node.tagName === "DIV" || node.tagName === "P") length += 1;
    }
  };
  for (const c of root.childNodes) visit(c);
  return length;
}

/** Put the caret at a plain-text offset (falls back to the end). */
function setCaretAt(root: HTMLElement, offset: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  let remaining = offset;
  let placed = false;
  const visit = (node: Node, parent: Node, index: number) => {
    if (placed) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent?.length ?? 0;
      if (remaining <= len) {
        range.setStart(node, remaining);
        range.collapse(true);
        placed = true;
        return;
      }
      remaining -= len;
      return;
    }
    if (node instanceof HTMLBRElement || node instanceof HTMLImageElement) {
      if (remaining === 0) {
        range.setStart(parent, index);
        range.collapse(true);
        placed = true;
        return;
      }
      remaining -= 1;
      return;
    }
    if (node instanceof HTMLElement && node.dataset.address !== undefined) {
      const len = 1 + node.dataset.address.length;
      if (remaining === 0) {
        range.setStart(parent, index);
        range.collapse(true);
        placed = true;
        return;
      }
      if (remaining <= len) {
        range.selectNodeContents(node);
        range.collapse(false);
        placed = true;
        return;
      }
      remaining -= len;
      return;
    }
    if (node instanceof HTMLElement) {
      let i = 0;
      for (const c of node.childNodes) {
        visit(c, node, i++);
        if (placed) return;
      }
      if (remaining === 0 && (node.tagName === "DIV" || node.tagName === "P")) {
        range.setStart(parent, index);
        range.collapse(true);
        placed = true;
        return;
      }
      if (node.tagName === "DIV" || node.tagName === "P") {
        if (remaining === 1) {
          // Just past the block: place at its end.
          range.selectNodeContents(node);
          range.collapse(false);
          placed = true;
          return;
        }
        if (remaining > 1) remaining -= 1;
      }
    }
  };
  let i = 0;
  for (const c of root.childNodes) {
    visit(c, root, i++);
    if (placed) break;
  }
  if (!placed) {
    range.selectNodeContents(root);
    range.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

interface MentionState {
  /** Plain-text offset of the `@` that opened the menu. */
  start: number;
  /** Plain-text offset of the caret, the end of the typed query. */
  off: number;
  query: string;
  index: number;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  { value, placeholder, maxLength, mentionables, onChange, onSend },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef(value);
  const caret = useRef<number | null>(null);
  const ignoreSync = useRef(false);
  const [mention, setMention] = useState<MentionState | null>(null);

  valueRef.current = value;
  const participants = mentionables ?? [];

  /** The `@word` the caret sits inside, or null when not mentioning. */
  const activeMention = (): Omit<MentionState, "index"> | null => {
    const root = rootRef.current;
    if (!root) return null;
    const plain = serializePlain(root);
    const off = caretOffsetOf(root);
    let start = -1;
    for (let i = off - 1; i >= 0; i--) {
      const c = plain[i];
      if (c === undefined) break;
      if (c === "@") {
        start = i;
        break;
      }
      if (/\s/.test(c)) return null;
    }
    if (start < 0) return null;
    return { start, off, query: plain.slice(start + 1, off) };
  };

  const syncMention = () => {
    const m = activeMention();
    setMention(m ? { ...m, index: 0 } : null);
  };

  const matches =
    mention === null
      ? []
      : participants
          .filter((a) => a.toLowerCase().includes(mention.query.toLowerCase()))
          .slice(0, 8);

  const pickMention = (address: string) => {
    const root = rootRef.current;
    const plain = root ? serializePlain(root) : valueRef.current;
    const m = activeMention();
    if (!m) return;
    const next = `${plain.slice(0, m.start)}@${address} ${plain.slice(m.off)}`;
    if (next.length > maxLength) return;
    const caretNext = m.start + address.length + 2;
    caret.current = caretNext;
    ignoreSync.current = true; // buildRich below already reflects `next`
    onChange(next);
    if (root) {
      buildRich(root, next, participants);
      setCaretAt(root, caretNext);
      caret.current = null;
      root.focus();
    }
    setMention(null);
  };

  // Rebuild the rich content only when the plain text changed from outside
  // (picker insert, conversation switch, send). Typing edits the DOM itself
  // and reports back through onInput; rebuilding there would eat the caret.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (ignoreSync.current) {
      ignoreSync.current = false;
      return;
    }
    if (serializePlain(root) === value) return;
    buildRich(root, value, participants);
    setCaretAt(root, caret.current ?? serializePlain(root).length);
    caret.current = null;
  }, [value, placeholder]);

  const readCaret = () => {
    if (rootRef.current) caret.current = caretOffsetOf(rootRef.current);
  };

  useImperativeHandle(ref, () => ({
    insertEmoji(emoji: string) {
      const root = rootRef.current;
      const current = root ? serializePlain(root) : valueRef.current;
      const at = caret.current ?? current.length;
      const next = `${current.slice(0, at)}${emoji}${current.slice(at)}`;
      if (next.length > maxLength) return;
      caret.current = at + emoji.length;
      ignoreSync.current = true; // buildRich below already reflects `next`
      onChange(next);
      if (root) {
        buildRich(root, next, participants);
        setCaretAt(root, caret.current);
        caret.current = null;
        root.focus();
      }
    },
    focus() {
      rootRef.current?.focus();
      if (rootRef.current)
        setCaretAt(rootRef.current, serializePlain(rootRef.current).length);
    },
  }));

  return (
    <div className="chat-input-shell">
      <div
        ref={rootRef}
        className="chat-input chat-input-rich"
        contentEditable
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder}
        onInput={() => {
          const root = rootRef.current;
          if (!root) return;
          const plain = serializePlain(root);
          if (plain.length > maxLength) {
            // Past the bound: rebuild from the last accepted value so the
            // editor cannot outgrow what the store allows.
            buildRich(root, valueRef.current.slice(0, maxLength), participants);
            setCaretAt(root, valueRef.current.length);
            return;
          }
          if (plain !== valueRef.current) onChange(plain);
          readCaret();
          syncMention();
        }}
        onKeyDown={(e) => {
          if (mention) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (matches.length) {
                const step = e.key === "ArrowDown" ? 1 : -1;
                setMention((m) =>
                  m
                    ? { ...m, index: (m.index + step + matches.length) % matches.length }
                    : m,
                );
              }
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setMention(null);
              return;
            }
            if ((e.key === "Enter" || e.key === "Tab") && matches.length) {
              e.preventDefault();
              const target = matches[mention.index] ?? matches[0];
              if (target) pickMention(target);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
            return;
          }
          if (e.key === "Enter" && e.shiftKey) {
            // A newline as <br>, so serialization stays one \n per break.
            e.preventDefault();
            const root = rootRef.current;
            const sel = window.getSelection();
            if (root && sel?.rangeCount) {
              const range = sel.getRangeAt(0);
              range.deleteContents();
              const br = document.createElement("br");
              range.insertNode(br);
              range.setStartAfter(br);
              range.collapse(true);
              sel.removeAllRanges();
              sel.addRange(range);
            }
            return;
          }
          readCaret();
        }}
        onKeyUp={() => {
          readCaret();
          syncMention();
        }}
        onClick={() => {
          readCaret();
          syncMention();
        }}
        onBlur={() => {
          readCaret();
          setMention(null);
        }}
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData?.getData("text/plain") ?? "";
          const root = rootRef.current;
          const sel = window.getSelection();
          if (!root || !sel?.rangeCount) return;
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const frag = document.createDocumentFragment();
          const lines = text.replace(/\r\n?/g, "\n").split("\n");
          lines.forEach((line, i) => {
            if (i > 0) frag.append(document.createElement("br"));
            if (line) frag.append(document.createTextNode(line));
          });
          range.insertNode(frag);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
          readCaret();
          syncMention();
        }}
      />
      {mention && matches.length > 0 && (
        <div
          className="chat-mention-menu"
          role="listbox"
          aria-label={t("Mention a member")}
        >
          {matches.map((a, i) => (
            <button
              key={a}
              type="button"
              role="option"
              aria-selected={i === mention.index}
              className={`chat-mention-item${i === mention.index ? " active" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setMention((m) => (m ? { ...m, index: i } : m))}
              onClick={() => pickMention(a)}
              title={a}
            >
              @{shortName(a)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
