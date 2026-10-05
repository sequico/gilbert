import "@blocknote/core/fonts/inter.css";
import type { Block } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { useCreateBlockNote } from "@blocknote/react";
import { plainTextFromBlocks } from "@/lib/knowledge";

/**
 * The block editor an article's body is written in (ADR 0024).
 *
 * BlockNote keeps its document internally and reports every change as the whole
 * document, so the editor is seeded once and never re-seeded -- the parent
 * remounts it, with a `key`, when the article it is showing changes. Without
 * that remount, an uncontrolled editor would carry the first article's blocks
 * into the second one and overwrite what the store holds.
 *
 * The plain text is derived here rather than in the store: the blocks are the
 * editor's source of truth, and `plainTextFromBlocks` is the one definition of
 * what a reader and an agent search over.
 */
export function KnowledgeEditor({
  blocks,
  editable,
  onChange,
}: {
  blocks: unknown[];
  editable: boolean;
  onChange: (blocks: unknown[], text: string) => void;
}) {
  const editor = useCreateBlockNote({
    initialContent: blocks.length ? (blocks as Block[]) : undefined,
  });
  /*
   * No document, no editor. SSR never happens in this app, but a missing DOM
   * global should read as an empty pane rather than crash a page that has
   * nothing to render into. The guard sits after the hook so the call order is
   * the same on every render.
   */
  if (typeof document === "undefined") return null;
  return (
    <BlockNoteView
      editor={editor}
      editable={editable}
      onChange={() => onChange(editor.document, plainTextFromBlocks(editor.document))}
    />
  );
}
