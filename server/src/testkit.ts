import assert from "node:assert/strict";
import { createServer } from "node:net";

/**
 * The scaffolding the server's suites share.
 *
 * A suite that runs against the mock boots it, waits for it and then posts JSON
 * at the app it built; several read one method's answer out of a JMAP response.
 * Those pieces are the same in every suite that needs them, so they live here
 * once, and a suite imports the one it uses.
 *
 * What stays in a suite is what differs: the fake server it stands up (`fetch`
 * stubs, the mock's own answers) and, where its routes want a signature of their
 * own, its `call` helper. Everything else — the `call` most suites share, a JMAP
 * poster, `postWith` and `loginWith` built on top of `call` — is here.
 *
 * Nothing here ships: this file is excluded from the build (`tsconfig.json`), so
 * `dist/` and the image that copies it hold no test scaffolding. A suite resolves
 * it from source — `tsx --test` runs the files themselves — so the exclusion
 * costs the typecheck nothing either, which is why `tsconfig.test.json` clears
 * `exclude` and reads this file as one of its own roots.
 */

/** One JMAP method call as a response carries it: name, arguments, call id. */
export type MethodCall = [string, Record<string, unknown>, string];

/** One call's answer, and a loud failure when the response carries none. */
export function responseOf(responses: MethodCall[], callId: string): MethodCall {
  const found = responses.find((r) => r[2] === callId);
  assert.ok(found, `${callId} should answer`);
  return found;
}

/**
 * The element a test has just asserted is there.
 *
 * Strict indexing reads every `list[i]` as possibly absent — right for a server,
 * noise for a test that asserted the length one line above: this states it once
 * and hands the element back.
 */
export function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  assert.ok(value !== undefined, `expected an element at ${index}`);
  return value;
}

/**
 * One JMAP method call, posted at a mock's `/jmap/` with a Basic credential and
 * the capabilities a suite speaks. A suite differs from another in those three
 * alone, so it builds its own `jmap` out of this one.
 */
export async function jmapCall(
  base: string,
  authorization: string,
  using: string[],
  methodCalls: unknown[],
): Promise<MethodCall[]> {
  const res = await fetch(`${base}/jmap/`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ using, methodCalls }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { methodResponses: MethodCall[] };
  return body.methodResponses;
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

/** The slice of a Hono app a suite's `call` drives. */
type RequestApp = {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
};

/**
 * A JSON route's answer: its status, and the body it parsed — of the type the
 * suite asks for, `Record<string, unknown>` unless it names its own.
 */
type JsonAnswer<B = Record<string, unknown>> = { status: number; body: B | null };

/** The one request every `call` helper below makes. */
async function requestJson<B>(
  app: RequestApp,
  headers: Record<string, string>,
  path: string,
  cookie: string,
  init: RequestInit,
): Promise<JsonAnswer<B> & { cookie: string }> {
  const res = await app.request(path, {
    ...init,
    headers: {
      ...headers,
      ...(init.headers as Record<string, string>),
      ...(cookie ? { cookie } : {}),
    },
  });
  const setCookie = res.headers.get("set-cookie");
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as B) : null,
    cookie: setCookie ? setCookie.split(";")[0]! : cookie,
  };
}

/**
 * A suite's JSON `call` against the app it built: it merges the suite's default
 * headers, carries the session cookie a sign-in answered into every request
 * after it, and hands back the parsed body. `B` is the suite's own body type.
 */
export function jsonCall<B = Record<string, unknown>>(
  app: RequestApp,
  headers: Record<string, string>,
): (path: string, init?: RequestInit) => Promise<JsonAnswer<B>> {
  let cookie = "";
  return async (path, init = {}) => {
    const answer = await requestJson<B>(app, headers, path, cookie, init);
    cookie = answer.cookie;
    return { status: answer.status, body: answer.body };
  };
}

/**
 * A suite's JSON `call` when the session is the caller's to pass — the same
 * request as `jsonCall`, but the cookie comes in as an argument, for a suite
 * that drives more than one identity.
 */
export function jsonCallAs<B = Record<string, unknown>>(
  app: RequestApp,
  headers: Record<string, string>,
): (
  path: string,
  cookie: string,
  init?: RequestInit,
) => Promise<JsonAnswer<B> & { cookie: string }> {
  return (path, cookie, init = {}) => requestJson<B>(app, headers, path, cookie, init);
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
