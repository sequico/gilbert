/**
 * The phone's bridge, as the administration reads it (ADR 0023).
 *
 * A status, not a setting: it says whether the bridge answers on this host, so
 * the administration can tell an operator the phone is unavailable and why.
 * The install guide is `INSTALL.md`; the client still proves the media path
 * before offering the phone.
 */
import { apiFetch } from "@/jmap/client";

/** Whether the bridge is running, and the reason if it is not. */
export interface PhoneStatus {
  available: boolean;
  reason: string | null;
}

/** `GET /api/admin/phone/status` — whether the bridge is running, and why not. */
export function fetchPhoneStatus(): Promise<PhoneStatus> {
  return apiFetch<PhoneStatus>("/api/admin/phone/status");
}
