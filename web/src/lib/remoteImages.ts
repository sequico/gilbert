import type { ImagePolicy } from "@/store/settings";

/**
 * Whether remote images in a message may load, from the reader's settings and
 * the sender.
 *
 * One decision, two seats: the message reader decides before it renders the
 * body, and the composer decides before it quotes a message into a draft. The
 * composer is why the second seat exists: quoting a message loads whatever that
 * quoted mail asks for — tracking pixels included — no matter what the reader
 * decided for that very message. Both seats answer the same question ("may this
 * sender's remote images load?") the same way, so both call this.
 *
 * The reader's own "show images for this message" click is deliberately not
 * part of the decision: it is per-view state, not a property of the message.
 * The view keeps it beside the call.
 */
export function remoteImagesAllowed(opts: {
  policy: ImagePolicy;
  /** Addresses the reader has said may always load images, lowercased. */
  trustedSenders: readonly string[];
  /** The message's From address, if it has one. */
  senderEmail?: string | null;
  /** Whether the sender is in the reader's address book. */
  inContacts?: boolean;
}): boolean {
  const { policy, trustedSenders, senderEmail, inContacts } = opts;
  if (policy === "always") return true;
  if (senderEmail && trustedSenders.includes(senderEmail.toLowerCase())) return true;
  if (policy === "contacts") return Boolean(inContacts);
  return false;
}

/**
 * Whether a message's remote images can be shown at all, given the reader's
 * decision and the installation.
 *
 * The decision above answers "may this sender's images load?"; this one answers
 * "can they?", and both have to hold. The app's Content Security Policy refuses
 * a direct fetch (`img-src 'self' data: blob:`, see APP_CSP in
 * server/src/static.ts), so a remote image reaches the reader only through the
 * server's proxy, and an installation that has turned the proxy off (`IMAGE_PROXY`)
 * has nothing to show whatever the policy or the reader's click says. The
 * reader must not ask the sanitiser for a URL this cannot load: written into
 * `src`, it is a broken image, and the click that was meant to fix it hides the
 * banner that says the images are blocked.
 *
 * The composer's quote asks only the first question. It keeps the sender's URL
 * in the draft's markup, where the outgoing message still carries the image,
 * even though this app will not load it.
 */
export function remoteImagesLoadable(allowed: boolean, proxy: boolean): boolean {
  return allowed && proxy;
}
