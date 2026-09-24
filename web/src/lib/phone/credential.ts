/**
 * A person's SIP account, read from their own account (ADR 0023).
 *
 * The account is account data: it follows the account the way settings do,
 * living in one document in the account's `gilbert` app folder — `sip.json` —
 * keyed by identity email, written by an administrator through the identity
 * door. The account's own client reads it to register the identity it sends as.
 */
import {
  parseSipCredentials,
  SIP_CREDENTIALS_FILE,
  type SipCredential,
} from "@gilbert/shared/phone";
import type { Id } from "@/jmap/types";
import { readAppJson } from "@/lib/appFolder";

export type { SipCredential };
export { SIP_CREDENTIALS_FILE };

/**
 * Every account the person holds, keyed by identity email, or an empty map.
 *
 * Absent, unreadable or malformed all answer the same way: no account. The
 * phone then has nothing to register and does not offer itself, which is the
 * honest answer to a document that is not there. The parse is the shared one,
 * so what the administration writes and what the phone reads cannot disagree.
 */
export async function readSipAccounts(
  accountId: Id,
): Promise<Record<string, SipCredential>> {
  return parseSipCredentials(await readAppJson(accountId, SIP_CREDENTIALS_FILE));
}

/** The account one identity holds, or null when the account holds none. */
export function accountFor(
  accounts: Record<string, SipCredential>,
  email: string | null | undefined,
): SipCredential | null {
  if (!email) return null;
  return accounts[email.toLowerCase()] ?? null;
}
