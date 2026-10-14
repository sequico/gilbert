/**
 * Where this product's source is said to live, for both tiers.
 *
 * The AGPL asks whoever runs a modified version to offer *that* version's
 * source, so a deployment that points `SOURCE_URL` at its own tree shows its own
 * repository on the sign-in page and in Settings → About. Two tiers answer the
 * question and both had the answer written out: `server/src/configuration.ts`
 * as the fallback for `SOURCE_URL`, and `web/src/lib/source.ts` as the fallback
 * for a session that has not arrived yet. A deployment that patched only the
 * server's was then contradicted by the client's copy on the one surface where
 * a visitor sees it before signing in.
 *
 * It is here for the same reason `capabilities.ts` holds a URN: a value both
 * tiers read is one value, and `.env.example` says the same thing again as the
 * environment variable's own comment, which is documentation rather than a
 * second definition.
 */
export const GILBERT_SOURCE_URL = "https://github.com/sequico/gilbert";
