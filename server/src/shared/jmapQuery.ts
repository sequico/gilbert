import type { Invocation } from "./jmap.js";

/**
 * The two calls a listing makes: ask for the ids, then ask for those objects.
 *
 * JMAP answers a query with ids and a get with the objects, and the second call
 * names the first one's result by reference — `#ids` → `resultOf` — rather than
 * a client fetching the ids and sending them back in a second request. Five
 * places in this tree wrote that pair out by hand: the app folder on both tiers,
 * the Files store twice, and the save-to-Files dialog. Written by hand, the
 * back-reference has to name the query it points at, and nothing checks that it
 * does — so the pair is here, once, with the reference built from the query name
 * rather than spelled beside it.
 *
 * No imports beyond the tuple type, so this reaches a bundle with nothing
 * attached.
 */

export interface QueryThenGet {
  /** The `/query` method, e.g. `FileNode/query`. */
  query: string;
  /** The `/get` method that reads the ids the query answered with. */
  get: string;
  accountId: string;
  /** The query's filter, when the read has one. */
  filter?: Record<string, unknown>;
  sort?: Array<{ property: string; isAscending: boolean }>;
  position?: number;
  limit?: number;
  /** The properties the get asks for; all of them when it names none. */
  properties?: string[];
}

/** The query and its get, as the two calls a JMAP request carries. */
export function queryThenGet({
  query,
  get,
  accountId,
  filter,
  sort,
  position,
  limit,
  properties,
}: QueryThenGet): Invocation[] {
  return [
    [
      query,
      {
        accountId,
        ...(filter ? { filter } : {}),
        ...(sort ? { sort } : {}),
        ...(position === undefined ? {} : { position }),
        ...(limit === undefined ? {} : { limit }),
      },
      "q",
    ],
    [
      get,
      {
        accountId,
        "#ids": { resultOf: "q", name: query, path: "/ids" },
        ...(properties ? { properties } : {}),
      },
      "g",
    ],
  ];
}
