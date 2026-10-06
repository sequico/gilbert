import assert from "node:assert/strict";
import { createServer } from "node:net";
import { PDFDocument } from "pdf-lib";

/**
 * The scaffolding the server's suites share.
 *
 * A suite that runs against the mock boots it, waits for it and then posts JSON
 * at the app it built; several build a PDF, and several read one method's answer
 * out of a JMAP response. Those pieces are the same in every suite that needs
 * them, so they live here once, and a suite imports the one it uses.
 *
 * What stays in a suite is what differs: the fake server it stands up (`fetch`
 * stubs, the mock's own answers) and its own `call` helper, whose signature its
 * routes decided. `postWith` and `loginWith` build their request on top of that
 * helper rather than replacing it.
 */

/** A PDF of `pages` pages, none of which carries a text layer of its own. */
export async function blankPdf(pages: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  for (let page = 0; page < pages; page++) document.addPage([300, 200]);
  return document.save();
}

/** One JMAP method call as a response carries it: name, arguments, call id. */
export type MethodCall = [string, Record<string, unknown>, string];

/** One call's answer, and a loud failure when the response carries none. */
export function responseOf(responses: MethodCall[], callId: string): MethodCall {
  const found = responses.find((r) => r[2] === callId);
  assert.ok(found, `${callId} should answer`);
  return found;
}

/**
 * A free loopback port for a suite's mock Stalwart.
 *
 * The mock binds a real socket, and a fixed port collides with whatever else
 * runs on the machine: a sibling test file racing for it, or a service
 * co-hosted on the developer's box. Asking the OS for a port it has just handed
 * back keeps the suite runnable anywhere, and the `test-ports` guard fails if a
 * file goes back to naming a number.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => {
        if (error) reject(error);
        else if (port) resolve(port);
        else reject(new Error("the OS handed back no port"));
      });
    });
  });
}

/** The mock is listening by the time its import resolves; give it a moment. */
export async function waitForPort(base: string, authorization: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${base}/.well-known/jmap`, {
        headers: { authorization },
      });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the mock never came up");
}

/** A POST of one JSON body through a suite's own `call` helper. */
export function postWith<R>(
  call: (path: string, init?: RequestInit) => Promise<R>,
): (path: string, body: unknown) => Promise<R> {
  return (path, body) => call(path, { method: "POST", body: JSON.stringify(body) });
}

/** The sign-in those suites send first, through a `call` that carries a cookie. */
export function loginWith<R>(
  call: (path: string, cookie: string, init?: RequestInit) => Promise<R>,
): (username: string, password: string) => Promise<R> {
  return (username, password) =>
    call("/api/auth/login", "", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
}
