import { lazyView } from "@/lib/lazyView";

/*
 * The pieces a section carries but only an action opens, each a chunk of its
 * own, fetched the first time somebody opens it: the composer, the contact
 * editor, the share dialog, the filter-from-message editor and the file
 * preview.
 *
 * They are defined here rather than beside each consumer because three of them
 * are opened from four to six places, and a `lazy()` wrapper written at every
 * call site is one rule stated six times — six places that can drift apart,
 * and six chances for a new call site to import the heavy module directly and
 * quietly put it back in the section's chunk.
 *
 * A piece that never loads fails the way a hung view does: `lazyView` races it
 * against the view timeout, so it reaches the crash boundary rather than
 * leaving a click with no answer.
 */

const loadComposer = () =>
  import("./compose/Composer").then((m) => ({ default: m.Composer }));

export const LazyComposer = lazyView(loadComposer);

/**
 * Fetch the composer while the browser is idle, once the mail section is up.
 *
 * The composer is the heaviest piece here and the one a reader is most likely
 * to open first, so it is fetched before it is asked for. It stays a separate
 * chunk either way: this moves when it arrives, not whether.
 */
export function warmComposer(): void {
  if (typeof window === "undefined") return;
  const warm = () => void loadComposer().catch(() => {});
  if ("requestIdleCallback" in window)
    window.requestIdleCallback(warm, { timeout: 5000 });
  else setTimeout(warm, 2000);
}

export const LazyContactEditor = lazyView(() =>
  import("./contacts/ContactEditor").then((m) => ({ default: m.ContactEditor })),
);

export const LazyShareDialog = lazyView(() =>
  import("./settings/ShareDialog").then((m) => ({ default: m.ShareDialog })),
);

export const LazyFilterFromMessageDialog = lazyView(() =>
  import("./mail/FilterFromMessage").then((m) => ({
    default: m.FilterFromMessageDialog,
  })),
);

export const LazyFilePreviewDialog = lazyView(() =>
  import("@/ui/filepreview").then((m) => ({ default: m.FilePreviewDialog })),
);
