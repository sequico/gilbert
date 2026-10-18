/**
 * The documents an article is read and written through.
 *
 * Narrow readers for the shapes `@gilbert/shared/knowledge` defines — a
 * document that does not read as this build's is absent — and the stored
 * title a document keeps.
 */

import {
  isKnowledgeDraft,
  isKnowledgeState,
  type KnowledgeDraft,
  type KnowledgeState,
  MAX_TITLE,
} from "../shared/knowledge.js";

export function asState(raw: unknown): KnowledgeState | null {
  return isKnowledgeState(raw) ? raw : null;
}

export function asDraft(raw: unknown): KnowledgeDraft | null {
  return isKnowledgeDraft(raw) ? raw : null;
}

/** The human title a document stores: trimmed, bounded, never empty. */
export function titleFor(value: unknown): string {
  const text = String(value ?? "")
    .trim()
    .slice(0, MAX_TITLE);
  return text || "Untitled";
}
