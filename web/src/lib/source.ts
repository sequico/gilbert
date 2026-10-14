/**
 * Where to point someone who wants this instance's source.
 *
 * The server says where its own lives, via the session's `gilbert.sourceUrl`;
 * this is only the fallback for the moment before it has been asked — the
 * sign-in page, which has no session. The address itself is the server's to
 * answer, so it lives in `@gilbert/shared/source` and not here: a deployment
 * running modified code must not be contradicted by a copy the browser carries.
 */
export { GILBERT_SOURCE_URL as DEFAULT_SOURCE_URL } from "@gilbert/shared/source";
