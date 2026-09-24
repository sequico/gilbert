/**
 * The phone's bridge, as the administration reads it (ADR 0023).
 *
 * A status, not a setting: it says whether the bridge answers on this host, the
 * Janus the deployment installed and the media range it opens, so the
 * administration can tell an operator what is out of place. The install guide
 * is `INSTALL.md`; the client still proves the media path before offering the
 * phone.
 */
import { apiFetch } from "@/jmap/client";

/** What the bridge status route answers. */
export interface PhoneStatus {
  /** Whether the daemon answers on loopback. */
  available: boolean;
  /** Why it does not, in a sentence, when it does not. */
  reason: string | null;
  /** The Janus the deployment installed, or null when there is none. */
  version: string | null;
  /** The media range the deployment opens. */
  mediaPorts: string;
}

/** `GET /api/admin/phone/status` — the bridge's state, for the administration. */
export function fetchPhoneStatus(): Promise<PhoneStatus> {
  return apiFetch<PhoneStatus>("/api/admin/phone/status");
}
