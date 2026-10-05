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
