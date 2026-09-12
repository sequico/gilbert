# ADR 0011 — The share target and the worker's cache

Status: Proposed (2026-09-12)

## Context

The operating system can hand Gilbert a payload: a photo, a link, a file, from
any other app's share sheet. The manifest announces a `share_target` — a
`POST` with `multipart/form-data` to a route inside the app's scope — and a
client-side router cannot answer a POST, so the **service worker** is what
stands at that door.

That makes the worker a boundary in three ways:

- it receives input it did not ask for, from an app it does not know, with no
  authentication of its own;
- it writes that payload into `CacheStorage` — a store the app's own code reads
  from — under names both sides have to agree on (`<base>/gilbert-share` for a
  payload, `<base>/gilbert-worker-facts` for the strings and mailbox ids a tab
  hands it, `<base>/gilbert-push-verification` for a verification code that
  arrived with no tab open), and the cache itself is `gilbert-v2`;
- it acts on mail as the reader does: a same-origin `fetch` to `/api/jmap`
  carries the session cookie, so an action on a notification (`Email/set`,
  archiving or marking read) is an ordinary authenticated call.

The worker is copied to `dist` verbatim rather than built, so it cannot import
the app's constants: every one of those names exists twice, once in
`web/public/sw.js` and once in `web/src/lib/`.

## Decision

1. **The worker holds no credential of its own.** The only credential involved
   is the session cookie the browser attaches to a same-origin request; the one
   header the API additionally requires (`x-requested-with: gilbert`) is not a
   secret. Nothing is stored in the worker, and nothing in a payload is.
2. **Shared state is `CacheStorage`, keyed by fixed names, and both copies of
   each name are pinned by a test.** `web/src/lib/__tests__/swCache.test.ts`
   reads the worker and asserts the cache name and the two keys agree with the
   app's — a drift there does not fail, it finds nothing.
3. **What waits for a tab expires.** A share nobody collects is dropped after
   ten minutes (`SHARE_MAX_AGE_MS`), so a forgotten payload cannot open a
   composer days later.
4. **A share names what to send, never who to.** The worker writes the payload;
   the app opens a draft with the body and the attachments and no recipient.
5. **A notification action is taken as the reader, not as a service.** It is
   the same authenticated call the open app would make, and a failure is
   reported rather than swallowed.

## Consequences

- A share requires the worker: with it unregistered the POST has nothing to
  answer it and the payload is lost. The manifest announces the target
  regardless, because that is how a manifest works.
- `SW_CACHE_NAME` has to advance whenever the shape of `facts` changes — a
  later tab would otherwise read an older payload as if it were current.
- The boundary is the browser's own storage, not Stalwart: nothing durable is
  written server-side by a share, and nothing says the payload is confidential
  from anybody with access to the device's profile.
- Android and Chromium implement share targets; iOS does not.
