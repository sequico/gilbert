import type { Invocation } from "./jmap.js";

/**
 * The two calls a listing makes: ask for the ids, then ask for those objects.
 *
 * JMAP answers a query with ids and a get with the objects, and the second call
 * names the first one's result by reference — `#ids` → `resultOf` — rather than
 * a client fetching the ids and sending them back in a second request. Six
 * places in this tree make that pair: the app folder on both tiers, the Files
 * store's tree walk, the calendar's event listing, the shared-contact scan and
 * the group roster. Written by hand, the back-reference has to name the query it
 * points at, and nothing checks that it does — so the pair is here, once, with
 * the reference built from the query name rather than spelled beside it.
 *
 * What this builds is **one page**, and one the server will resolve: the query's
 * `limit` is clamped to the server's own `/get` ceiling (`maxObjectsInGet`),
 * because a page the get cannot resolve is refused **whole** — not cut short,
 * not truncated — so a caller naming a limit the server cannot resolve would
 * take its whole listing down with it. The ceiling is a parameter rather than
 * read here: this module carries no client, and each tier states its own.
 * Reading a level longer than one page is the caller's loop, and the loops
 * differ — one stops on a short page, one stops at a cap it set, one stops when
 * its position reaches the server's `total` — so it stays at the call site,
 * each advancing `position` by what came back.
 *
 * No imports beyond the tuple type, so this reaches a bundle with nothing
 * attached.
 */

/** A JMAP result reference: the call a later one reads its ids from. */
interface ResultRef {
  resultOf: string;
  name: string;
  path: string;
}

/**
 * Build a JMAP result reference argument (`"#ids": {...}`).
 *
 * A reference names the call it points at (`resultOf`), the method that call
 * used (`name`) and the path into its answer (`path`). Spelled by hand, the
 * three have to agree with a call that may move or be renamed in another file,
 * and nothing checks that they do.
 */
export function ref(resultOf: string, name: string, path: string): ResultRef {
  return { resultOf, name, path };
}

interface QueryThenGet {
  /** The `/query` method, e.g. `FileNode/query`. */
  query: string;
  /** The `/get` method that reads the ids the query answered with. */
  get: string;
  accountId: string;
  /**
   * The server's own `/get` ceiling (`client.maxObjectsInGet`), which caps how
   * many ids this page may name. It is required so a new call site cannot name
   * a limit the server will refuse the pair over without meaning to.
   */
  maxObjectsInGet: number;
  /**
   * The query's filter, when the read has one.
   *
   * The shape is the query's own: a `Filter` the protocol defines, or the one
   * this tree builds for a search (`shared/search.ts`'s `SearchFilter`), which
   * is not a record by construction. This passes it through untouched, and only
   * the server judges it.
   */
  filter?: unknown;
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
  maxObjectsInGet,
  filter,
  sort,
  position,
  limit,
  properties,
}: QueryThenGet): Invocation[] {
  // A page the get cannot resolve is refused whole, so a limit wider than the
  // ceiling becomes the ceiling; a caller naming none asks for one page of it.
  const page = limit === undefined ? maxObjectsInGet : Math.min(limit, maxObjectsInGet);
  return [
    [
      query,
      {
        accountId,
        ...(filter ? { filter } : {}),
        ...(sort ? { sort } : {}),
        ...(position === undefined ? {} : { position }),
        limit: page,
      },
      "q",
    ],
    [
      get,
      {
        accountId,
        "#ids": ref("q", query, "/ids"),
        ...(properties ? { properties } : {}),
      },
      "g",
    ],
  ];
}
