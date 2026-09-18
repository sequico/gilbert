/**
 * The formatters the mail and file surfaces share, and nothing else.
 *
 * Four of them, in two families: `formatListDate` and `formatFullDate` for a
 * message's place in time, `formatRelative` and `formatSize` for "how long ago"
 * and "how big". Each composes the locale-aware primitives in `./datetime` —
 * `formatListDate` is the one that picks between them by how recent the instant
 * is — and `formatSize` is the product's own because no platform call answers
 * "1.2 MB" the way a file list needs.
 *
 * What is deliberately not here: the date and time primitives themselves
 * (`./datetime`), the calendar arithmetic and the naive-local form (`./dates`,
 * `@gilbert/shared/localDateTime`), and `isSameDay`, which is `./dates`'.
 * `formatTime` and `formatMonthYear` used to be pass-throughs to `formatClock`
 * and `formatMonthYear` in `./datetime`, which is two names for one function
 * and one import away from being one.
 */
import {
  formatClock,
  formatDate,
  formatDayMonth,
  formatFullDateTime,
  relativeFormat,
} from "./datetime";
import { isSameDay } from "./dates";

export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Gmail-style compact date for list views. */
export function formatListDate(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (isSameDay(d, now)) return formatClock(d);
  if (d.getFullYear() === now.getFullYear()) return formatDayMonth(d);
  return formatDate(d);
}

/** Full date for message headers, e.g. "Sat, Aug 22, 2026, 3:14 PM" or "Sa., 22.08.2026 15:14" */
export function formatFullDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatFullDateTime(d);
}

export function formatRelative(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  const diff = (d.getTime() - now.getTime()) / 1000;
  const abs = Math.abs(diff);
  const rtf = relativeFormat();
  if (!rtf) return formatListDate(iso, now);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), "day");
  return formatListDate(iso, now);
}

/**
 * A short random id for a key the client mints and never shows.
 *
 * Local to this client and deliberately weak: it names an entry inside one
 * document the reader is composing — an alert, a location, an image — where
 * what matters is only that two of them in the same document differ, and
 * nothing else ever compares them.
 */
export function uid(prefix = "u"): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
