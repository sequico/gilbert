import { describe, expect, it } from "vitest";
import { PAYLOAD_PROPS } from "@/lib/webpush";
import { readSource, workerSource } from "./readSource";

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
   * The handshake settles here. A code stored for a tab to collect is a code
   * the server keeps re-sending (`last_verify`, per account), and each re-send
   * is a push answered with nothing — which Chrome answers with a notification
   * of its own.
   */
  it("hands the verification code back to the server itself", () => {
    expect(worker).toContain("PushSubscription/set");
    expect(worker).toContain("verificationCode: code");
    expect(worker).toContain('const WEBPUSH_CAP = "urn:ietf:params:jmap:webpush-vapid"');
    // Nothing is left for a tab to collect, so there is no second door.
    expect(worker).not.toContain("push-verification");
  });

  /*
   * A delivery that arrived as a state change rather than as a payload names
   * its account and nothing else, so the worker reads the message back and
   * announces it: a push answered with silence is Chrome's own "this site has
   * been updated in the background". Where there is no Inbox to read, the
   * notice names the mailbox the briefing has.
   */
  it("reads a payload-less delivery back from the Inbox and announces it", () => {
    expect(worker).toContain("await mailNotifications(changed, facts, strings);");
    expect(worker).toContain('filter: { inMailbox: inboxId, notKeyword: "$seen" }');
    expect(worker).toContain("if (!account?.inboxId)");
    expect(worker).toContain("strings.newMail");
  });

  /*
   * The read-back is gated by what this device has already been told, because
   * unread is not the same as new: without the watermark every wake-up would
   * re-announce mail the reader has deliberately left unread. The entry is the
   * worker's own — no tab reads it, so no second copy of the name exists.
   */
  it("announces only what is newer than the watermark it wrote", () => {
    expect(worker).toContain("gilbert-mail-watermark");
    expect(worker).toContain('Date.parse(watermarks[accountId] ?? "")');
    expect(worker).toContain("await rememberMailWatermarks(watermarks);");
    const app = ["src/lib/swFacts.ts", "src/lib/webpushEnable.ts"].map(readSource);
    for (const src of app) expect(src).not.toContain("gilbert-mail-watermark");
  });

  /*
   * One renderer for a message however it was found, tagged by the message's
   * own id: the two pushes of one delivery must not stack, and a group's
   * message must be titled the same way whichever path built it.
   */
  it("renders the payload and the read-back through one notification", () => {
    expect(worker).toContain(
      "await notifyMail(deliveryAccountId, account, email, strings);",
    );
    expect(worker).toContain("for (const email of fresh) await notifyMail(");
    expect(worker).toContain(`tag: \`gilbert-\${email.id || body}\``);
  });

  /*
   * The two paths render the same message, and the worker cannot import the
   * app's list — `public/sw.js` is copied to the build verbatim. So the one
   * list is held together by a test: a property dropped on either side is a
   * notification that renders differently depending on which push carried it.
   */
  it("asks for the same Email properties in the payload and in the read-back", () => {
    const list = /const MAIL_PROPS = \[([^\]]*)\]/.exec(worker)?.[1] ?? "";
    const props = list.match(/"([^"]+)"/g)?.map((p) => p.replace(/"/g, ""));
    expect(props).toEqual(PAYLOAD_PROPS);
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
    // A share nobody has opened, the briefing, and the mail watermark this
    // worker keeps for itself: written by one context and read by another (or
    // by the next worker), so they live in a cache of their own that activation
    // never empties. Copying them onto a bump would race a handoff written
    // between the copy and the delete.
    expect(worker).toContain("k !== VERSION && k !== HANDOFF");
    expect(worker).not.toContain("isHandoffKey");
  });

  it("writes every handoff into the cache activation keeps", () => {
    // The share stash, the briefing read, and the mail watermark's read and
    // write each open HANDOFF. A handoff written into the shell cache instead
    // is lost at the next activation.
    expect(worker.match(/\.open\(HANDOFF\)/g) ?? []).toHaveLength(4);
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
