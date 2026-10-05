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

let composerWarmed = false;

/**
 * Fetch the composer while the browser is idle, once per document.
 *
 * The composer is the heaviest piece here and the one a reader is most likely
 * to open first — the drawer's Compose button is on every screen (the shell
 * falls back to mail's action where no module owns the section) — so it is
 * fetched before it is asked for. It stays a separate chunk either way: this
 * moves when it arrives, not whether.
 *
 * The once-flag is what keeps a re-mount (StrictMode's double effect, or
 * signing out and back in) from scheduling a second fetch, and the failure is
 * logged rather than swallowed: the click loads the chunk anyway, and the
 * warning is what makes a chunk that cannot be fetched at all visible before
 * somebody presses Compose.
 */
export function warmComposer(): void {
  if (composerWarmed || typeof window === "undefined") return;
  composerWarmed = true;
  const warm = () =>
    void loadComposer().catch((err) => {
      console.warn("[gilbert] composer: the chunk did not warm", err);
    });
  if (typeof window.requestIdleCallback === "function")
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
