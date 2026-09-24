/**
 * A person's SIP address and password, read from their own account (ADR 0023).
 *
 * The credentials are account data: they follow the account the way settings
 * do, living in one document in the account's `gilbert` app folder —
 * `sip.json` — keyed by identity email, written by an administrator through the
 * identity door. They are read here rather than served by a route of their own,
 * because the account can already read its own Files and there is nothing for a
 * second door to protect.
 */
import {
  isSipCredential,
  SIP_CREDENTIALS_FILE,
  type SipCredential,
  type SipCredentialsDocument,
} from "@gilbert/shared/phone";
import type { Id } from "@/jmap/types";
import { readAppJson } from "@/lib/appFolder";

export type { SipCredential };
export { SIP_CREDENTIALS_FILE };

/**
 * Every credential the account holds, keyed by identity email, or an empty map.
 *
 * Absent, unreadable or malformed all answer the same way: no credential. The
 * phone then has nothing to register and does not offer itself, which is the
 * honest answer to a document that is not there.
 */
export async function readSipCredentials(
  accountId: Id,
): Promise<Record<string, SipCredential>> {
  const parsed = await readAppJson(accountId, SIP_CREDENTIALS_FILE);
  if (typeof parsed !== "object" || parsed === null) return {};
  const identities = (parsed as SipCredentialsDocument).identities;
  if (typeof identities !== "object" || identities === null) return {};
  const out: Record<string, SipCredential> = {};
  for (const [key, value] of Object.entries(identities))
    if (isSipCredential(value)) out[key.toLowerCase()] = value;
  return out;
}

/** The credential for one identity email, or null when the account holds none. */
export function credentialFor(
  credentials: Record<string, SipCredential>,
  email: string | null | undefined,
): SipCredential | null {
  if (!email) return null;
  return credentials[email.toLowerCase()] ?? null;
}
