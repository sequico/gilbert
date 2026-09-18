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
   * The buttons and the deep link both hang off the message's own id, so a
   * payload without one is shown as a notice and carries no action — the
   * reason `subscriptionPayload` has to ask Stalwart for `id`.
   */
  it("draws an action and a deep link only for a payload that names an id", () => {
    expect(worker).toContain("actions: email.id ? actionsFor(facts) : []");
    expect(worker).toMatch(
      /url: email\.id \? `\$\{BASE\}\/mail\/inbox\/\$\{email\.id\}`/,
    );
  });
});
