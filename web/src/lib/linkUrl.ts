/**
 * Whether a stored value is a link this app will draw.
 *
 * A contact's website and an event's virtual location can arrive from outside
 * the writer -- an imported vCard, a group's shared address book, the Global
 * contacts directory an administrator fills for every account, an invitation --
 * so a `javascript:` or `data:` value would be a link that says "Website" and
 * runs when it is clicked. That the app's own Content Security Policy refuses
 * the navigation (`script-src 'self'`, see APP_CSP in server/src/static.ts) is
 * not the guard: it is there in a built app and not under the dev server, and a
 * link the app will not follow is not one it draws.
 *
 * `http`, `https`, `mailto` and `tel` are the schemes it links -- the list the
 * composer builds a typed URL from, so the two cannot drift apart. A value with
 * no scheme at all is not guessed at: the surfaces that write one store an
 * absolute URL.
 */
const LINK_SCHEME = /^(https?:|mailto:|tel:)/i;

export function isLinkUrl(value: string): boolean {
  return LINK_SCHEME.test(value.trim());
}
