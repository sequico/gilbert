import { describe, expect, it } from "vitest";
import { workerSource } from "./readSource";

/*
 * The rules the worker's push handler applies, held against the reason for
 * them.
 *
 * `web/public/sw.js` is not a module a test can import: it registers listeners
 * on `self` at load. So this file reads it, and each assertion below fails when
 * the rule it names is removed — which is what makes it a guard rather than a
 * description. The loader is shared with `swCache.test.ts`, which reads the
 * same file for the names the two sides agree on.
 */
const worker = workerSource();

describe("the push handler's rules", () => {
  /*
   * Someone reading the app already knows: a focused, visible window is fed by
   * its own event stream, so a notification over it is the same news twice.
   */
  it("says nothing while the app is focused on screen", () => {
    expect(worker).toMatch(
      /windows\.some\(\(w\) => w\.focused && w\.visibilityState === "visible"\)/,
    );
    expect(worker).toMatch(/if \(windows\.some\(.*\)\) return;/);
  });

  /*
   * A delivery from a server that answers with a state change rather than a
   * payload — which is what the subscription asks for — is still new mail, and
   * saying so is the honest rendering of a payload that names no sender.
   */
  it("still notifies for a delivery that carried no message", () => {
    expect(worker).toContain("if (!emails.length)");
    expect(worker).toContain("strings.newMail");
  });

  /*
   * The buttons hang off the message's own id — a payload without one is shown
   * as a notice and carries no action, the reason `subscriptionPayload` has to
   * ask Stalwart for `id` — and the deep link carries the Inbox id and the
   * thread id the route is made of. A literal `inbox`, or the message's own id
   * in the thread's place, is a folder and a thread the app cannot resolve.
   */
  it("draws an action only for an id, and a deep link from the Inbox and thread ids", () => {
    expect(worker).toContain("actions: email.id ? actionsFor(account, strings) : []");
    expect(worker).toMatch(
      /\$\{BASE\}\/mail\/\$\{account\.inboxId\}\/\$\{email\.threadId\}/,
    );
    expect(worker).not.toMatch(/\$\{BASE\}\/mail\/inbox\//);
  });
});

/*
 * Installing, activating and the offline answer. Each rule below fails when
 * the mechanism it names is removed, which is what makes this a guard rather
 * than a description: a worker that cannot activate leaves
 * `navigator.serviceWorker.ready` unfulfilled, and `registerThisBrowser` waits
 * on it, so "turn notifications on" hangs with nothing to show.
 */
describe("the worker's install, activation and offline rules", () => {
  it("caches the shell one URL at a time, so a single miss cannot block installing", () => {
    expect(worker).toContain("Promise.allSettled(SHELL.map((url) => cache.add(url)))");
    // `addAll` rejects the whole batch and would take `skipWaiting` with it.
    expect(worker).not.toContain("addAll(SHELL)");
  });

  it("activates whatever the shell cache did", () => {
    // `skipWaiting` runs after the try/catch, not inside the shell fill.
    expect(worker).toMatch(/catch \{[\s\S]*?\}\s*await self\.skipWaiting\(\);/);
  });

  it("keeps the handoff cache through a version bump, and migrates nothing", () => {
    // A share nobody has opened, a verification that arrived with no tab, the
    // briefing: written by one context and read by another, so they live in a
    // cache of their own that activation never empties. Copying them onto a
    // bump would race a handoff written between the copy and the delete.
    expect(worker).toContain("k !== VERSION && k !== HANDOFF");
    expect(worker).not.toContain("isHandoffKey");
  });

  it("writes every handoff into the cache activation keeps", () => {
    // The share stash, the verification code and the briefing each open
    // HANDOFF. A handoff written into the shell cache instead is lost at the
    // next activation.
    expect(worker.match(/\.open\(HANDOFF\)/g) ?? []).toHaveLength(3);
  });

  it("answers a first offline navigation from the pre-cached root", () => {
    // The kept copy is written by a navigation that succeeded, so the very
    // first offline load has none and used to resolve undefined.
    expect(worker).toMatch(
      /\(await caches\.match\(SHELL_KEY\)\)\s*\?\?\s*\(await caches\.match\(`\$\{BASE\}\/`\)\)/,
    );
  });

  it("keeps only a successful page as the shell", () => {
    expect(worker).toContain(
      'if (res.ok && (res.headers.get("content-type") ?? "").startsWith("text/html"))',
    );
  });

  it("caches an asset without letting a failed put escape, and answers when offline", () => {
    expect(worker).toMatch(
      /void caches\s*\.open\(VERSION\)\s*\.then\(\(c\) => c\.put\(req, copy\)\)\s*\.catch\(\(\) => \{\}\)/,
    );
    expect(worker).toContain(
      "caches.match(req).then((again) => again ?? Response.error())",
    );
  });
});
