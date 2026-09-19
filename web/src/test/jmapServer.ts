import { vi } from "vitest";

/**
 * The JMAP envelope, faked once for the suites that need one.
 *
 * A test that drives a store has to answer the client's `POST /api/jmap`: parse
 * `methodCalls`, hand back one `methodResponses` entry per call, in order, with
 * the call's own id. Thirty suites wrote that loop out themselves, each with its
 * own map of method names to answers and its own grab-bag default — the same
 * envelope implemented thirty times, and a place for the copies to disagree
 * about what an unanswered method returns.
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
 */

/** One call, as the fake saw it. */
export interface JmapCall {
  method: string;
  args: Record<string, unknown>;
  id: string;
}

/** What a handler answers for one call: that method's response object. */
export type JmapAnswer = (call: JmapCall) => unknown;

export interface JmapFake {
  /** Answer every call of `method` with what `answer` returns. */
  on(method: string, answer: JmapAnswer): JmapFake;
  /** Every call the client made, in order. The array is live: it grows. */
  calls: JmapCall[];
  /** The calls of one method, in order, as they stood when this was called. */
  callsTo(method: string): JmapCall[];
  /** How many times `method` was asked. */
  count(method: string): number;
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
  const calls: JmapCall[] = [];

  const fake: JmapFake = {
    on(method, answer) {
      handlers.set(method, answer);
      return fake;
    },
    calls,
    callsTo: (method) => calls.filter((call) => call.method === method),
    count: (method) => calls.filter((call) => call.method === method).length,
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
