import type { Quota } from "@/jmap/types";

/**
 * The one quota an account's storage reads (RFC 9425).
 *
 * Stalwart answers **one octets quota per account**, scope `account`: its `used`
 * is the account's whole disk usage — mail, files, calendar and contacts
 * together — and its `types` names them all, so the bar shows a group's storage
 * the same way it shows a person's and no data type is left out. A domain or
 * global row is not this account's, so the account-scoped octets row wins; a
 * server that names no scope gets the first octets row.
 *
 * One rule, so the sidebar's bar and the folders settings cannot disagree about
 * which number is the account's.
 */
export function accountQuota(quotas: Quota[]): Quota | undefined {
  return (
    quotas.find((q) => q.resourceType === "octets" && q.scope === "account") ??
    quotas.find((q) => q.resourceType === "octets")
  );
}
