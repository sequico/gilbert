/**
 * What a swipe on a message row does, and what it should say it is about to do.
 *
 * The reader picks one action for each direction in Settings, but an action is
 * not a fixed thing: "delete" out of Deleted Items is permanent, "report spam"
 * inside Junk Mail is the opposite request, and "archive" while looking at the
 * archive is nothing at all. The strip revealed behind the row has to name the
 * thing that will actually happen, in the folder it is happening in -- a row
 * that slides open to reveal the word "Archive" and then does nothing is worse
 * than one that does not slide.
 *
 * So a direction with no meaning here resolves to `null`, and a null direction
 * is one the row simply will not move in.
 */

import { t } from "@/lib/i18n";
import type { DeleteEffect } from "@/lib/mailDelete";

export type SwipeAction =
  | "archive"
  | "delete"
  | "spam"
  | "read"
  | "star"
  | "move"
  | "none";

export interface SwipeContext {
  /** The role of the folder on screen, where it has one. */
  role?: string | null;
  /**
   * What deleting this row would do to it, from the one rule (ADR 0015).
   *
   * Handed in rather than worked out from `role`, because the row is the only
   * thing that knows which folders hold *this* message: the label used to be
   * decided by the folder on screen alone, so the same gesture destroyed a
   * message in Junk Mail under the word "Delete".
   */
  deleteEffect: DeleteEffect;
  /**
   * Whether this reader may take that delete at all — ADR 0015's answer for the
   * account on screen, from `deleteEntryOffered`.
   *
   * A direction that would be refused resolves to `null` and the row does not
   * move in it, which is what the record asks for and what the record's own
   * words describe: a strip that slides open to reveal an action it cannot take
   * is worse than one that does not slide. The default is `true` so a caller
   * that has no account to ask about is not silently stripped of its gesture.
   */
  deleteOffered?: boolean;
  /** Whether the row is unread — "mark as read" is a toggle, and says so. */
  unread: boolean;
  starred: boolean;
}

/**
 * Which glyph the strip shows. Named for the state it is offering rather than
 * the setting it came from: "mark as unread" and "not spam" are the same two
 * settings as their opposites but nothing like the same icon, and a strip that
 * says "Not spam" beside a spam icon is asking to be misread at a glance.
 */
export type SwipeIcon =
  | "archive"
  | "delete"
  | "spam"
  | "not-spam"
  | "read"
  | "unread"
  | "star"
  | "unstar"
  | "move";

export interface SwipeDescriptor {
  action: Exclude<SwipeAction, "none">;
  label: string;
  icon: SwipeIcon;
  /** Which colour the strip behind the row takes. */
  tone: "danger" | "warn" | "accent" | "neutral";
  /**
   * Whether firing it takes the row out of the list. Those slide the rest of
   * the way off before they fire, so the message is gone from under the finger
   * rather than snapping home and then vanishing a frame later.
   */
  removes: boolean;
  /**
   * For the two actions that are toggles, the state this swipe sets — so the
   * caller fires exactly what the strip promised. Read back off the row
   * instead and a slow finger can invert it: the strip that said "Mark as
   * read" would mark as unread if a push update landed mid-gesture.
   */
  on?: boolean;
}

export function describeSwipe(
  action: SwipeAction,
  ctx: SwipeContext,
): SwipeDescriptor | null {
  switch (action) {
    case "archive":
      // Archiving out of the archive is the one no-op worth refusing outright.
      return ctx.role === "archive"
        ? null
        : { action, label: "Archive", icon: "archive", tone: "accent", removes: true };
    case "delete":
      /*
       * Withdrawn where the rule would refuse it (ADR 0015): a delete that would
       * end the message, by a reader who may not end one. The condition reads the
       * effect as well as the offer, so a caller that passes a stale offer cannot
       * take away a direction that only files — a move is never what the rule
       * refuses.
       */
      if (ctx.deleteEffect === "final" && ctx.deleteOffered === false) return null;
      return {
        action,
        label: ctx.deleteEffect === "final" ? "Delete forever" : "Delete",
        icon: "delete",
        tone: "danger",
        removes: true,
      };
    case "spam":
      // Nothing you wrote is spam you received, so the gesture stays inert in
      // the two folders that hold your own mail.
      if (ctx.role === "drafts" || ctx.role === "sent") return null;
      return ctx.role === "junk"
        ? { action, label: "Not spam", icon: "not-spam", tone: "warn", removes: true }
        : { action, label: "Report spam", icon: "spam", tone: "warn", removes: true };
    case "read":
      return {
        action,
        label: ctx.unread ? "Mark as read" : "Mark as unread",
        icon: ctx.unread ? "read" : "unread",
        tone: "neutral",
        removes: false,
        on: ctx.unread,
      };
    case "star":
      return {
        action,
        label: ctx.starred ? t("Remove star") : t("Add star"),
        icon: ctx.starred ? "unstar" : "star",
        tone: "warn",
        removes: false,
        on: !ctx.starred,
      };
    case "move":
      // The folder picker opens over the list, so the row comes home first.
      return { action, label: "Move to…", icon: "move", tone: "accent", removes: false };
    case "none":
      return null;
  }
}

/** The Settings picker's options, in the order they are offered. */
export const SWIPE_CHOICES: ReadonlyArray<{ value: SwipeAction; label: string }> = [
  { value: "archive", label: "Archive" },
  { value: "delete", label: "Delete" },
  { value: "read", label: "Mark as read / unread" },
  { value: "star", label: "Star / unstar" },
  { value: "spam", label: "Report spam / not spam" },
  { value: "move", label: "Move to…" },
  { value: "none", label: "Nothing" },
];
