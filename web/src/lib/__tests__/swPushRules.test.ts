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
    expect(worker).toContain("actions: email.id ? actionsFor(facts) : []");
    expect(worker).toMatch(
      /\$\{BASE\}\/mail\/\$\{facts\.inboxId\}\/\$\{email\.threadId\}/,
    );
    expect(worker).not.toMatch(/\$\{BASE\}\/mail\/inbox\//);
  });
});
