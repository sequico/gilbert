/**
 * The key a shared item is held under, in one place.
 *
 * A calendar or an address book shared with this account arrives with ids that
 * are only unique inside the account they came from, so everything that keys
 * such an item — the events in the store, the hidden-calendar toggles, the
 * `addedShares` list that records what the reader subscribed to — keys it by
 * account **and** id. One separator, one function, because the list is what the
 * reader's own settings document stores: a second spelling of the same key is
 * not a cosmetic difference, it is a selection that stops being found. The
 * format is stored data and cannot change without a migration of
 * `settings.addedShares`.
 */
export const sharedKey = (accountId: string, id: string): string => `${accountId}:${id}`;
