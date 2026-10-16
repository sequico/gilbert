/**
 * The group-access vocabulary both tiers read.
 *
 * A group's documents live in the group's own account, and the principal that
 * reaches them is the Master. A surface that reaches for one and is refused
 * receives a code and the section it was asked for, never a sentence: the
 * client composes the sentence from the catalogue in force, so it reads in the
 * language the surface is set to and falls back to the English where a
 * catalogue does not carry it. The codes and the section's name are what
 * travels, and this is their one home, because the server refuses with them and
 * the web reads them (`@gilbert/shared/groupAccess`).
 */

/**
 * The section of a group's own documents a surface was standing at.
 *
 * A group the Master is not granted on has no path to any of it, but not for
 * the same document, and the refusal a person reads names the section they were
 * standing at. That name travels as this value rather than inside a sentence,
 * so the sentence can be composed in the language the person reads.
 */
export type GroupNeed = "labels" | "knowledge" | "agent documents";

/** The code a group the Master is not granted on travels as, on every surface. */
export const GROUP_NOT_ACCESSIBLE = "group_not_accessible";

/**
 * The code a group nobody could ask about travels as.
 *
 * A probe that did not answer is not a group the Master lacks: the surface says
 * what it could not establish, so a person retries or looks at the server
 * rather than editing a grant that was never the problem (ADR 0005).
 */
export const GROUP_UNREADABLE = "group_unreadable";

/** The two ways a group's documents are out of reach, as codes a client reads. */
export type GroupDeniedCode = typeof GROUP_NOT_ACCESSIBLE | typeof GROUP_UNREADABLE;

/**
 * The two ways opening the Master's session fails with a reason of its own: the
 * credential this deployment carries was refused, or the account could not be
 * reached at all. Both travel as a code — their strings are the contract a
 * client composes a sentence from — and the surface shows the sentence.
 */
export type CredentialRefusalCode = "agent_credentials_rejected" | "agent_unreachable";
