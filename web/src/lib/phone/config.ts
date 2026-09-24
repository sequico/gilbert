/**
 * The phone's pure rules: whether it is offered, what the media stack is built
 * with, and which number a contact dials (ADR 0023).
 *
 * Kept out of the store and the views so the rules are testable without a SIP
 * server, a microphone or a rendered component — the parts of the phone that
 * cannot be exercised in a mock are the parts that need no exercising.
 */
import type { InstallationSip } from "@gilbert/shared/installation";
import type { ContactCard } from "@/jmap/types";

/**
 * Whether this installation offers the phone at all.
 *
 * On with no endpoint is not offered: a phone that can only fail is an entry
 * that lies. The reader's own credentials are asked separately, in
 * `credentials.ts`, because a deployment with the phone on and no credential
 * for this account has nothing to register either.
 */
export function phoneOffered(sip: InstallationSip | undefined): boolean {
  return Boolean(sip?.enabled && sip.endpoints.length);
}

/** The ICE servers SIP.js is built with, from the installation's STUN and TURN. */
export function iceServers(sip: InstallationSip): RTCIceServer[] {
  const servers: RTCIceServer[] = [];
  if (sip.stun.length) servers.push({ urls: sip.stun });
  for (const turn of sip.turn) {
    if (!turn.url) continue;
    servers.push({
      urls: turn.url,
      ...(turn.username ? { username: turn.username } : {}),
      ...(turn.credential ? { credential: turn.credential } : {}),
    });
  }
  return servers;
}

/** Every number a card carries, the preferred one first. */
export function contactPhoneNumbers(card: ContactCard): string[] {
  return Object.values(card.phones ?? {})
    .filter((phone) => Boolean(phone.number?.trim()))
    .slice()
    .sort((a, b) => (a.pref ?? 1) - (b.pref ?? 1))
    .map((phone) => phone.number.trim());
}

/** The number the phone dials for a contact, or null when it carries none. */
export function dialTarget(card: ContactCard): string | null {
  return contactPhoneNumbers(card)[0] ?? null;
}
