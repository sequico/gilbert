import { vi } from "vitest";

/**
 * The JMAP envelope, faked once for the suites that need one.
 *
 * A test that drives a store has to answer the client's `POST /api/jmap`: parse
 * `methodCalls`, hand back one `methodResponses` entry per call, in order, with
 * the call's own id. This is that envelope, written once, so a suite registers
 * the methods its assertions are about instead of carrying its own map of
 * method names to answers and its own grab-bag default.
 *
 * This is the envelope, not a server. It does not model a mailbox, a folder
 * tree, a calendar or a quota: a suite registers the methods its assertions are
 * about, closes over whatever state it keeps, and gets every call recorded. The
 * simulation of Stalwart is `server/src/mock`, which is the one that has to
 * agree with a real server; this is a stub whose only promises are the envelope
 * and the record of what was asked.
 *
 * A method nobody registered is answered with the empty result of every shape
 * (`list`, `ids`, `created`, `notFound`, …), which is what the hand-written
 * defaults answered with too. A suite that needs a different answer registers
 * the method.
 *
 * A suite can also make the server REFUSE a call, which is not an answer at all:
 * JMAP refuses in an entry whose method name is the literal `"error"` and whose
 * body is an error object, so no handler can produce one — it would have to
 * answer under a name no call carried. `onError` is the second registration,
 * beside `on` and consulted first: it is asked for every call of that method
 * before any handler, returns the error object for the calls to refuse, and
 * returns nothing for the calls to answer normally. That is what a server that
 * refuses a call over a ceiling and accepts it under one looks like — a
 * refusal decided per call, not a different server per test.
 *
 * Every answer is handed back as soon as the call is read, so a suite that has
 * to hold one response in flight while it inspects the store mid-request keeps
 * its own stub: a promise returned from `on` would land in `methodResponses` as
 * a promise rather than as the answer it settles to.
 */

/** One call, as the fake saw it. */
export interface JmapCall {
  method: string;
  args: Record<string, unknown>;
  id: string;
}

/** What a handler answers for one call: that method's response object. */
export type JmapAnswer = (call: JmapCall) => unknown;

/**
 * The refusal of one call: an error object for the calls to refuse, nothing for
 * the calls to answer normally.
 */
export type JmapRefusal = (
  call: JmapCall,
) => { type: string; description?: string } | undefined;

export interface JmapFake {
  /** Answer every call of `method` with what `answer` returns. */
  on(method: string, answer: JmapAnswer): JmapFake;
  /** Refuse every call of `method` that `refuse` answers an error object for. */
  onError(method: string, refuse: JmapRefusal): JmapFake;
  /** Every call the client made, in order. The array is live: it grows. */
  calls: JmapCall[];
  /** The calls of one method, in order, as they stood when this was called. */
  callsTo(method: string): JmapCall[];
}

/**
 * The empty result of every shape, built per call.
 *
 * One object rather than one per method kind: a caller reads the key it asked
 * about, and a suite that asserts on `notCreated` gets `{}` whether it asked for
 * a set or a query. It is deliberately not a claim about the server — the only
 * field it takes from the call is the account the question was asked about.
 */
const emptyResult = (call: JmapCall): Record<string, unknown> => ({
  accountId: call.args.accountId ?? "a1",
  state: "1",
  oldState: "1",
  newState: "2",
  list: [],
  notFound: [],
  ids: [],
  total: 0,
  queryState: "q",
  position: 0,
  canCalculateChanges: false,
  created: {},
  updated: {},
  destroyed: [],
  notCreated: {},
  notUpdated: {},
  notDestroyed: {},
});

/**
 * Install a fake JMAP envelope as the global `fetch`.
 *
 * Unsuitable URLs are not modelled: the fetch stub answers any request that
 * carries `methodCalls` and nothing else. A suite that also needs a session, a
 * blob or an upload answered keeps its own fetch stub beside this one.
 */
export function fakeJmapServer(): JmapFake {
  const handlers = new Map<string, JmapAnswer>();
  const refusals = new Map<string, JmapRefusal>();
  const calls: JmapCall[] = [];

  const fake: JmapFake = {
    on(method, answer) {
      handlers.set(method, answer);
      return fake;
    },
    onError(method, refuse) {
      refusals.set(method, refuse);
      return fake;
    },
    calls,
    callsTo: (method) => calls.filter((call) => call.method === method),
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        methodCalls: Array<[string, Record<string, unknown>, string]>;
      };
      const methodResponses = body.methodCalls.map(([method, args, id]) => {
        const call: JmapCall = { method, args, id };
        calls.push(call);
        const refuse = refusals.get(method);
        const error = refuse?.(call);
        if (error) return ["error", error, id];
        const answer = handlers.get(method);
        return [method, answer ? answer(call) : emptyResult(call), id];
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ methodResponses, sessionState: "1" }),
      } as Response;
    }),
  );

  return fake;
}
