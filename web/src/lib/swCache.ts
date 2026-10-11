/**
 * The name of the handoff cache the service worker keeps.
 *
 * It is `HANDOFF` in `web/public/sw.js`, and the worker is not built from this
 * source -- it is copied to `dist` verbatim, so nothing checks that the two
 * agree. They have to: the worker leaves a share, a push verification and its
 * briefing there for a tab to collect, and a name that has drifted does not
 * fail, it silently finds nothing. A push verification never completes; a share
 * arrives at an empty composer.
 *
 * It is deliberately not the shell cache the worker versions and empties on
 * every activation. What lands here is written by one context and read by
 * another, possibly much later, so emptying it would lose a share nobody had
 * opened yet -- and migrating it onto a version bump would race a handoff
 * written between the copy and the delete. So the cache is kept whole across
 * every version, and nothing migrates it. One copy on this side of the line, so
 * at least the app cannot disagree with itself.
 */
export const SW_CACHE_NAME = "gilbert-handoff";
