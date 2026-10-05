import { vi } from "vitest";
import type { Identity } from "@/jmap/types";
import { resetShareSupport } from "@/lib/share";

/**
 * The scaffolding the web's suites share.
 *
 * Three shapes recur across the suites: one identity as the routes answer it, a
 * zero-delay timer that lets a store settle, and a `navigator` whose share
 * support is whatever the test says it is. Each is the same in every file that
 * needs it, so it lives here once.
 */

/** One identity as the routes answer it, with the fields a surface reads. */
export const identity = (id: string, name: string, email: string): Identity =>
  ({
    id,
    name,
    email,
    replyTo: null,
    bcc: null,
    textSignature: "",
    htmlSignature: "",
    mayDelete: true,
  }) as Identity;

/** A zero-delay timer: the queued microtasks and the odd macrotask run. */
export const flushMicrotasks = () => new Promise<void>((res) => setTimeout(res, 0));

/** Two rounds of it, for a store that answers a refresh behind a first read. */
export const flushTwice = async () => {
  await flushMicrotasks();
  await flushMicrotasks();
};

/** A browser whose share support is whatever the test hands it. */
export function stubNavigator(nav: Partial<Navigator>) {
  vi.stubGlobal("navigator", nav as Navigator);
  resetShareSupport();
}
