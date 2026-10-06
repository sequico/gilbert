/**
 * What this instance calls itself, when nothing has said otherwise yet.
 *
 * `APP_NAME` is a runtime environment variable, so the real answer arrives
 * from the server -- on `/api/config` before anybody signs in, and on the
 * session afterwards. This is what stands in until it does, and what stands
 * for good if the request fails: a sign-in form with no name on it would be
 * worse than one with the wrong name.
 *
 * One constant rather than the string written out at each of them, because
 * three copies of a default is how two of them end up stale.
 */
export const DEFAULT_APP_NAME = "Gilbert";

/**
 * The name, expanded: Gilbert is a backronym, and this is what it stands for.
 *
 * A name rather than a sentence, so it is never translated -- the sign-in form
 * shows it in English beside the logo, while the interface around it may be in
 * any language. It is the one definition: no catalogue carries it and nothing
 * looks it up.
 */
export const ACRONYM_TAGLINE =
  "General-purpose Intelligent Lifecycle Butler for Enterprise Resource Traceability";
