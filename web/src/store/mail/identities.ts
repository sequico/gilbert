import type { Id, Identity } from "@/jmap/types";
import { settings } from "../settings";

/**
 * The identity reads already on their way, by account, so two callers share
 * one request and the fire-and-forget at the foot of this file cannot ask
 * twice for the same list.
 */
export const identitiesLoading = new Map<Id, Promise<Identity[]>>();

/**
 * What an account's list is before it has been read.
 *
 * One constant rather than a fresh `[]` per call, because `ownIdentities` is
 * read through a store selector: a new array every render would tell every
 * subscriber the answer had changed.
 */
export const EMPTY_IDENTITIES: Identity[] = [];

/**
 * How many reads each account has been through, so a read can be spent.
 *
 * `identitiesLoading` is the half that joins two callers to one request; this
 * is the half that tells a request its answer is no longer wanted. Dropping
 * the entry starts a fresh read and does nothing about the one already on its
 * way: its `Identity/get` was asked before the write and answers with the list
 * from before it, which it would then put back under the account when it
 * landed. A read takes the number it was started under, and a read whose
 * number has moved keeps what it got to itself.
 */
export const identitiesReads = new Map<Id, number>();

/** Spend the read on screen -- if any -- and open the way for the next one. */
export function overtakeIdentities(accountId: Id): void {
  identitiesReads.set(accountId, (identitiesReads.get(accountId) ?? 0) + 1);
  identitiesLoading.delete(accountId);
}

export function sortIdentities(list: Identity[], accountId: Id): Identity[] {
  const pref = settings().defaultIdentityByAccount[accountId];
  return [...list].sort((a, b) =>
    a.id === pref ? -1 : b.id === pref ? 1 : a.email.localeCompare(b.email),
  );
}
