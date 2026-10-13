/* gilbert service worker.
   Two jobs: app-shell caching for installability and fast loads (API requests
   are never cached), and Web Push, which is the only part of gilbert that runs
   when no tab is open. */
const VERSION = "gilbert-v3";

/*
 * The name of the shell cache, and the lever that refreshes it.
 *
 * `install` fills this cache from SHELL and `activate` deletes every cache that
 * is neither this one nor HANDOFF. A browser only runs `install` again when
 * this file's own bytes changed, so an asset listed in SHELL that changed while
 * this file did not -- an icon, the manifest -- stays at its old copy in the
 * cache, and offline loads keep serving it. Bumping the string is what makes
 * the shell be fetched again.
 */

/*
 * The cache that carries a handoff from one context to another.
 *
 * A share the operating system posted before a tab existed, the briefing a tab
 * leaves for a push long after, and the mail watermark this worker keeps for
 * itself across the pushes it is woken by: a share and the briefing are written
 * by one context and read by another, a watermark is written and read by
 * workers that share nothing else, and none of them may live in the versioned
 * shell cache, which `activate` empties on every bump. This one is never
 * deleted and never migrated -- it survives every version whole, so nothing has
 * to be carried across a delete it could race.
 *
 * `web/src/lib/swCache.ts` carries the same name on the app's side; the two
 * have to match or the handoff is silently not found. Nothing in the build
 * makes them agree, so a test does (`lib/__tests__/swCache.test.ts`).
 */
const HANDOFF = "gilbert-handoff";

/*
 * The mount, worked out rather than configured.
 *
 * This file is copied to the build verbatim -- Vite's `base` never touches
 * public/ -- so there is nothing to substitute BASE_PATH into. It does not
 * need one: the worker is served from the mount, so its own address says
 * where that is. `/mail/sw.js` gives `/mail`, `/sw.js` gives `""`, which is
 * the same canonical form the rest of the app uses.
 *
 * Deriving it here also means the worker cannot disagree with the page that
 * registered it, which a second copy of the value in a build-time constant
 * eventually would.
 */
const BASE = new URL("./", self.location).pathname.replace(/\/$/, "");
/*
 * The shell: everything a first paint needs, images included.
 *
 * Both colorways of the lockup and of the mark are here, though a theme shows
 * only one of each. The stylesheet picks between them, not a request: the theme
 * is known before the first paint, so both are in the tree and the one it did
 * not pick is the one an offline load would otherwise be missing.
 */
const SHELL = [
  `${BASE}/`,
  `${BASE}/manifest.webmanifest`,
  `${BASE}/img/logo.png`,
  `${BASE}/img/logo-inverse.png`,
  `${BASE}/img/mark.png`,
  `${BASE}/img/mark-inverse.png`,
  `${BASE}/img/icon-192.png`,
  `${BASE}/favicon.ico`,
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      /*
       * One entry at a time, and never at the cost of activating.
       *
       * `addAll` rejects the whole batch when any one URL fails, and that
       * rejection would take `skipWaiting` with it: the new worker would never
       * activate, `navigator.serviceWorker.ready` -- which `registerThisBrowser`
       * waits on -- would never settle, and turning notifications on would hang
       * with nothing to show for it. The shell is a cache, not a gate.
       */
      try {
        const cache = await caches.open(VERSION);
        await Promise.allSettled(SHELL.map((url) => cache.add(url)));
      } catch {
        /* no cache storage: activation still has to happen */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      /*
       * Empty every cache that is neither the shell nor the handoff one.
       *
       * The handoff cache holds what one context writes for another to read
       * later, and what this worker writes for its own next waking -- a share
       * the operating system posted before a tab existed, the briefing, the
       * mail watermark -- so it is kept whole and never migrated: a version
       * bump empties the shell cache, which is what that lever is for, and
       * leaves the handoffs where they are. Copying them across would race a
       * handoff written between the copy and the delete, and the one lost that
       * way is a share nobody opens, or mail announced twice.
       */
      const stale = (await caches.keys()).filter((k) => k !== VERSION && k !== HANDOFF);
      await Promise.all(stale.map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

/*
 * Where a share from the operating system is left for a tab to collect.
 *
 * Absolute and anchored to the mount, for the same reason the mail watermark's
 * key is: a relative key is resolved against the URL of whoever asks, and the
 * worker and a tab deep in `/mail/inbox/…` are not at the same place.
 *
 * The files go in one entry each and the rest in a JSON index beside them,
 * because the Cache API stores Responses and a File is already one body.
 */
const SHARE_KEY = `${BASE}/gilbert-share`;
const SHARE_MAX_FILES = 20;

/*
 * Take delivery of a share.
 *
 * This is a POST that navigates: the operating system submits a form at the
 * app and expects a page back. Nothing in Gilbert can answer it directly --
 * the app is a client-side router with no endpoint at that address, and the
 * server behind it would have to grow one that understood the composer. So the
 * worker takes the body, puts it where a tab can find it, and redirects to the
 * app, which then opens a draft holding it.
 *
 * The redirect happens whatever went wrong. A share that fails to stash costs
 * whatever was being shared, which is bad; a share that fails to *respond*
 * costs that and leaves the reader looking at a browser error page where they
 * expected their mail, which is worse.
 *
 * There is one case this cannot cover, and the server is deliberately not
 * taught to: an app still installed whose worker has been cleared away. The
 * POST then reaches the server, which answers 405, and the share is lost
 * either way -- the payload only ever existed in that request body. A server
 * route would trade a plain error for a silent nothing, and a share that
 * vanishes without saying so is the harder of the two to notice.
 */
async function stashShare(request) {
  try {
    const form = await request.formData();
    const cache = await caches.open(HANDOFF);
    const meta = {
      at: Date.now(),
      title: String(form.get("title") ?? ""),
      text: String(form.get("text") ?? ""),
      url: String(form.get("url") ?? ""),
      files: [],
    };
    const files = form
      .getAll("files")
      .filter((f) => f && typeof f === "object" && "name" in f && f.size > 0);
    for (const [i, f] of files.slice(0, SHARE_MAX_FILES).entries()) {
      const key = `${SHARE_KEY}/${i}`;
      await cache.put(
        key,
        new Response(f, {
          headers: { "content-type": f.type || "application/octet-stream" },
        }),
      );
      meta.files.push({
        key,
        name: f.name || `file-${i + 1}`,
        type: f.type || "application/octet-stream",
      });
    }
    await cache.put(
      SHARE_KEY,
      new Response(JSON.stringify(meta), {
        headers: { "content-type": "application/json" },
      }),
    );
  } catch {
    /* nothing to hand on: the app opens on an empty inbox rather than an error */
  }
  // Absolute, because `Response.redirect` rejects a bare path outright rather
  // than resolving it -- so `${BASE}/mail` would throw here and the share
  // would end at a browser error page instead of the inbox.
  return Response.redirect(
    new URL(`${BASE}/mail?share=1`, self.location.origin).href,
    303,
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method === "POST" && new URL(req.url).pathname === `${BASE}/share`) {
    event.respondWith(stashShare(req));
    return;
  }
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(`${BASE}/api/`)) return;

  // Hashed build assets: cache-first.
  if (url.pathname.startsWith(`${BASE}/assets/`)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req)
            .then((res) => {
              if (res.ok) {
                const copy = res.clone();
                /*
                 * Fire and forget, with the rejection caught: a full cache or
                 * a body that cannot be cloned must not surface as an
                 * unhandled rejection beside a response that served fine.
                 */
                void caches
                  .open(VERSION)
                  .then((c) => c.put(req, copy))
                  .catch(() => {});
              }
              return res;
            })
            /*
             * Nothing cached and the network gone. A network error is the
             * honest answer -- the asset is genuinely unreachable -- and it
             * keeps the rejection from becoming the response itself.
             */
            .catch(() => caches.match(req).then((again) => again ?? Response.error())),
      ),
    );
    return;
  }

  // Navigations & everything else: network-first, fall back to cached shell.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          /*
           * Every navigation refreshes the kept copy of the app page and, from
           * the list the page carries, fetches the rest of the build quietly.
           * An app page fetched for a reader's own tab must be the page's own
           * bytes, so the response is cloned rather than consumed.
           *
           * Only a success: an error page, or a proxy's interstitial, must not
           * be kept as the shell and served to the next offline load.
           */
          if (res.ok && (res.headers.get("content-type") ?? "").startsWith("text/html"))
            event.waitUntil(refreshShell(res.clone()));
          return res;
        })
        /*
         * Offline. The kept copy answers when a navigation has already written
         * one; `${BASE}/`, which `install` pre-caches, answers the first offline
         * load before any navigation has had the chance.
         */
        .catch(
          async () =>
            (await caches.match(SHELL_KEY)) ??
            (await caches.match(`${BASE}/`)) ??
            Response.error(),
        ),
    );
    return;
  }
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});

/*
 * Keep the offline copy of the app page current, and fetch the rest of the
 * build behind it.
 *
 * The app page lists every script of its build (the asset-list plugin in
 * `vite.config.ts`). Without that list the worker only ever learned about the
 * files a reader happened to ask for, so the first time after a deploy that
 * somebody opened the composer, settings or a viewer, they waited on the server
 * for that code -- and the lazy views are hundreds of kilobytes each.
 *
 * Best effort throughout: a load cut short is carried on at the next
 * navigation, which calls this again, and a build changing over mid-fetch costs
 * a 404 that is simply skipped.
 */
const SHELL_KEY = `${BASE}/__shell`;
const PRECACHE_PARALLEL = 3;

/*
 * The kept copy is under its own key rather than under `${BASE}/`.
 *
 * The cache is keyed by request, and `${BASE}/` is the app root -- storing the
 * shell page there would answer a *request for the root* out of the cache, in
 * front of the network-first handler that is supposed to decide for itself. A
 * key nothing ever requests keeps the copy a fallback and nothing else.
 */

/** The scripts the page names, minus the language catalogs. */
function precacheList(html) {
  const m = html.match(
    /<script type="application\/json" id="gilbert-assets">([^<]*)<\/script>/,
  );
  if (!m) return [];
  try {
    const list = JSON.parse(m[1]).precache;
    return Array.isArray(list)
      ? list.filter((p) => typeof p === "string" && p.startsWith(`${BASE}/assets/`))
      : [];
  } catch {
    return [];
  }
}

async function refreshShell(res) {
  const html = await res.text();
  const cache = await caches.open(VERSION);
  const prev = await cache.match(SHELL_KEY);
  if (!prev || (await prev.text()) !== html) {
    await cache.put(
      SHELL_KEY,
      new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
  }
  await precache(html, cache);
}

async function precache(html, cache) {
  // A reader who has asked the browser to save data has said what they want.
  if (self.navigator.connection?.saveData) return;
  const wanted = [];
  for (const path of precacheList(html)) {
    if (!(await cache.match(path))) wanted.push(path);
  }
  const next = async () => {
    for (let path = wanted.shift(); path; path = wanted.shift()) {
      try {
        const res = await fetch(path, { credentials: "same-origin" });
        if (res.ok) await cache.put(path, res);
      } catch {
        /* offline, or a deploy changing over: the next navigation tries again */
      }
    }
  };
  await Promise.all(Array.from({ length: PRECACHE_PARALLEL }, next));
}

/* ------------------------------------------------------------------ */
/* Web Push                                                            */
/* ------------------------------------------------------------------ */

/*
 * Stalwart signs with VAPID and pushes straight to the browser's push service;
 * nothing here talks to Gilbert's server on the way in. The payload is an
 * EmailPush object (draft-ietf-jmap-emailpush) carrying enough of the message
 * to show a useful notification without a round-trip, which is what lets a
 * notification appear immediately rather than after a request.
 *
 * What it can do is ask; what it cannot do is be sure of an answer, since the
 * session may be gone by the time it does — see the note on `jmap()`. So the
 * payload still carries the message and the request is only made when
 * somebody presses something.
 *
 * What it also cannot do is stay quiet. A push answered without a notification
 * gives the browser nothing to count, and Chrome's own answer to that is a
 * notification of its own — "this site has been updated in the background" —
 * which the reader cannot configure away without turning the site's
 * notifications off altogether. So every wake-up this file receives is answered
 * with something true about it: the payload with its message, the state change
 * with the mail read back from the Inbox, and the handshake with the code.
 *
 * The handshake is the one answer addressed to the server rather than to the
 * reader: it echoes a code back, which is what a subscription needs to stop
 * being silent, and it shows nothing. The browser may therefore still show its
 * own notice over that one push, once per subscription.
 */

/*
 * The account a mail link belongs to, as the query parameter that names it.
 *
 * The route names a folder and a conversation and neither says whose they are,
 * so a folder id another account also holds would resolve against the account
 * on screen -- and answer "no such conversation" for a message this account
 * never had. `web/src/lib/mailLink.ts` names the same parameter and the app
 * honours it; a test holds the two spellings together
 * (`lib/__tests__/swPushRules.test.ts`).
 */
const ACCOUNT_PARAM = "a";

/** `?a=<account>` for a link, or nothing when the account is not known. */
function accountQuery(accountId) {
  return accountId ? `?${ACCOUNT_PARAM}=${encodeURIComponent(accountId)}` : "";
}

/*
 * The capability `PushSubscription/set` is asked with. Named here because the
 * worker builds its own `using` arrays (see `jmap()`) and this is the one method
 * that needs it; the URN itself is one record, `CAPABILITIES.webpushVapid` in
 * `server/src/shared/capabilities.ts`.
 */
const WEBPUSH_CAP = "urn:ietf:params:jmap:webpush-vapid";

/*
 * Hand the verification code back to the server.
 *
 * A JMAP subscription delivers a `PushVerification` first and stays silent
 * until the client echoes its code back, and until it is answered the server
 * sends one per pass to the newest unverified subscription of the account
 * (`last_verify`, per account). A code that is only stored for a tab to collect
 * is therefore a code the server keeps re-sending, and every re-send is a push
 * that shows the reader nothing. Answering it here settles the handshake with
 * no tab open.
 *
 * The call is an ordinary JMAP one: the session cookie is same-origin and
 * httpOnly, exactly as it is for `runAction`. A code that cannot be answered —
 * the session gone, the connection down, or a payload that names no id and no
 * code — is dropped rather than retried in a loop, because the server's next
 * send is the retry. A device whose session is gone is therefore woken with
 * codes it cannot echo until somebody signs in again, which is also the moment
 * the app re-registers the device; how many of those wake-ups a real server
 * sends is the debt this rests on.
 *
 * ADR-0016 OWED: verification-background-answer
 */
async function verifyPushSubscription(data) {
  const id = typeof data.pushSubscriptionId === "string" ? data.pushSubscriptionId : "";
  const code = typeof data.verificationCode === "string" ? data.verificationCode : "";
  if (!id || !code) return;
  try {
    await jmap(
      [["PushSubscription/set", { update: { [id]: { verificationCode: code } } }, "0"]],
      ["urn:ietf:params:jmap:core", WEBPUSH_CAP],
    );
  } catch {
    /* unanswerable: the server sends the next code, and this tries again with it */
  }
}

/*
 * What a tab wrote down for this worker: the account, which mailbox is the
 * archive, and the worker's own text in the reader's language. See
 * `lib/swFacts.ts` for why any of that has to be handed over rather than
 * worked out here.
 *
 * Everything that depends on it is skipped when it is missing, which is the
 * state between installing this worker and next opening the app. An action
 * button with no label, or one that files mail into a mailbox guessed by name,
 * is worse than the notification that was here before.
 */
const FACTS_KEY = `${BASE}/gilbert-worker-facts`;

async function readFacts() {
  try {
    const hit = await (await caches.open(HANDOFF)).match(FACTS_KEY);
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}

/** The briefing's entry for one account, or null when it lists none. */
function accountFact(facts, accountId) {
  return (facts?.accounts ?? []).find((a) => a.accountId === accountId) ?? null;
}

/*
 * A JMAP call, made as the reader.
 *
 * Gilbert's session is an httpOnly cookie against its own origin, and the only
 * other thing the API asks for is a fixed `x-requested-with` header that is
 * not a secret and is not held anywhere. A same-origin fetch from here carries
 * the cookie like any other, so `Email/set` from a notification is an ordinary
 * request.
 *
 * What is genuinely not available is anything the *tab* holds in memory, and
 * the answer is that the API asks for none of it.
 *
 * The session can still be gone -- expired, signed out, or a cookie that did
 * not survive the browser closing -- which arrives as a 401 and is reported
 * rather than swallowed. A tap that silently does nothing is the failure worth
 * avoiding here: the reader has already put the phone down.
 */
async function jmap(
  methodCalls,
  using = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
) {
  const res = await fetch(`${BASE}/api/jmap`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-requested-with": "gilbert",
    },
    body: JSON.stringify({ using, methodCalls }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  // A JMAP method can fail inside a 200. Treat that as a failure too, rather
  // than reporting success because the transport was fine.
  const first = body?.methodResponses?.[0];
  if (!first || first[0] === "error") throw new Error(first?.[1]?.type || "error");
  const notUpdated = first[1]?.notUpdated;
  if (notUpdated && Object.keys(notUpdated).length) throw new Error("notUpdated");
  return body;
}

function textOf(email, strings) {
  const from = email?.from?.[0];
  const who = from?.name || from?.email || strings.newMessage;
  const what = email?.subject || strings.noSubject;
  return { title: who, body: what, preview: email?.preview || "" };
}

/*
 * Two, because that is what a phone shows. `Notification.maxActions` is 2 on
 * Android Chrome, and anything past it is dropped silently -- so these are the
 * two worth having rather than the two that happened to come first. Both are
 * triage: they are what somebody does to a notification they have read the
 * whole of on the lock screen and does not need to open.
 *
 * Reply is deliberately not among them. It cannot be done from here, so it
 * would have to open the app -- and an action that opens the app is what
 * tapping the notification already does.
 */
function actionsFor(account, strings) {
  if (!account || !strings) return [];
  const actions = [];
  if (account.archiveId) actions.push({ action: "archive", title: strings.archive });
  actions.push({ action: "read", title: strings.markRead });
  return actions;
}

/* ------------------------------------------------------------------ */
/* Mail: the payload, and the state change that carries none           */
/* ------------------------------------------------------------------ */

/*
 * What this worker has already announced on this device, per account.
 *
 * A mail-shaped state change names the account and nothing else, so the message
 * has to be read back from the Inbox -- and a read that trusted "the newest
 * unread" on its own would announce mail the reader had deliberately left
 * unread, every time anything arrived. What gates it is the instant this worker
 * last announced for that account, which is why it is written down: a push
 * wakes a worker that remembers nothing.
 *
 * It lives in the handoff cache, which activation never empties, and it is the
 * worker's own entry -- no tab reads it, so there is no second copy of the name
 * to keep in step. A stale entry is inert: an account id belongs to one account,
 * so a later sign-in never reads it.
 *
 * Where cache storage is refused, or two wakes read the map at once and the
 * later write wins, an account's advance is lost: the next read for it has no
 * watermark and seeds one instead of announcing, so the cost is one wake-up
 * that says nothing, never a backlog announced as news.
 */
const MAIL_WATERMARK_KEY = `${BASE}/gilbert-mail-watermark`;

async function readMailWatermarks() {
  try {
    const hit = await (await caches.open(HANDOFF)).match(MAIL_WATERMARK_KEY);
    const seen = hit ? await hit.json() : null;
    return seen && typeof seen === "object" ? seen : {};
  } catch {
    return {};
  }
}

async function rememberMailWatermarks(watermarks) {
  try {
    await (await caches.open(HANDOFF)).put(
      MAIL_WATERMARK_KEY,
      new Response(JSON.stringify(watermarks), {
        headers: { "content-type": "application/json" },
      }),
    );
  } catch {
    /* no cache storage: the next read for this account seeds a watermark again */
  }
}

/**
 * Move this device's watermark for one account on.
 *
 * Read immediately before the write, so the accounts a concurrent wake is
 * carrying are picked up rather than overwritten. The value is normalised, so
 * two instants from the server can be compared however they were spelled.
 */
async function advanceMailWatermark(accountId, at) {
  if (!Number.isFinite(at)) return;
  const watermarks = await readMailWatermarks();
  watermarks[accountId] = new Date(at).toISOString();
  await rememberMailWatermarks(watermarks);
}

/*
 * How many messages of a burst one wake-up announces, and what a notification
 * is built from.
 *
 * One number for both paths — the payload carries up to this many and the
 * read-back asks for the same number — so neither can quietly drop the mail the
 * other would have shown; a burst longer than this is the same partial
 * announcement either way. The property list is the one the subscription asks
 * Stalwart for (`PAYLOAD_PROPS` in `web/src/lib/webpush.ts`), because the two
 * paths render the same message: the payload one, and this one. They have to
 * agree, since whichever arrives second replaces the other in place under the
 * message's own tag.
 */
const MAIL_MAX = 5;
const MAIL_PROPS = ["id", "threadId", "from", "subject", "preview", "receivedAt"];

/*
 * How recent a message has to be to count as news on a device that has no
 * watermark for the account yet.
 *
 * A delivery's push follows the write within seconds, so "just now" is what the
 * push is about; a push the push service held back (a device asleep for hours)
 * therefore stays silent on that first read, which costs one unannounced
 * delivery for an account this device has never been told anything about — never
 * a backlog announced as news, which is what an unguarded "newest unread" read
 * would do every time.
 */
const MAIL_FRESH_MS = 15 * 60 * 1000;

/** The newest unread messages of an Inbox, newest first. */
async function newestUnread(accountId, inboxId) {
  const found = await jmap([
    [
      "Email/query",
      {
        accountId,
        filter: { inMailbox: inboxId, notKeyword: "$seen" },
        sort: [{ property: "receivedAt", isAscending: false }],
        limit: MAIL_MAX,
      },
      "q",
    ],
  ]);
  const ids = found?.methodResponses?.[0]?.[1]?.ids;
  if (!Array.isArray(ids) || !ids.length) return [];
  const got = await jmap([
    ["Email/get", { accountId, ids, properties: MAIL_PROPS }, "g"],
  ]);
  const list = got?.methodResponses?.[0]?.[1]?.list;
  return Array.isArray(list) ? list : [];
}

/*
 * One mail notification, whichever path built it.
 *
 * One renderer, so a message that arrived as an `EmailPush` and a message the
 * worker read back from the Inbox cannot show the same arrival two ways -- and,
 * because the tag is the message's own id, the second answer replaces the first
 * rather than stacking beside it. A group's message is titled with the group as
 * well as the sender, so a lock screen names both.
 */
async function notifyMail(accountId, account, email, strings) {
  const { title, body, preview } = textOf(email, strings);
  const heading =
    account && !account.own && account.name ? `${title} · ${account.name}` : title;
  await self.registration.showNotification(heading, {
    body: preview ? `${body}\n${preview}` : body,
    icon: `${BASE}/img/icon-192.png`,
    badge: `${BASE}/img/favicon-64.png`,
    // One notification per message, collapsing repeats of the same message by
    // tag so a re-push does not stack.
    tag: `gilbert-${email.id || body}`,
    // Only where there is a message to act on: a payload without an id can be
    // shown but not archived, and a button that cannot work should not be drawn.
    actions: email.id ? actionsFor(account, strings) : [],
    data: {
      /*
       * The route is `/mail/<mailbox id>/<thread id>`, so the link needs the
       * account's real Inbox id and the message's thread id -- never the literal
       * `inbox` or the message's own id, neither of which the app can resolve
       * (it answers "that folder no longer exists"). Without a known Inbox,
       * open /mail and let it redirect.
       */
      url: account?.inboxId
        ? `${BASE}/mail/${account.inboxId}${
            email.threadId ? `/${email.threadId}` : ""
          }${accountQuery(accountId)}`
        : `${BASE}/mail`,
      id: email.id || null,
      title,
      accountId,
      archiveId: account?.archiveId ?? null,
      failed: strings.failed ?? null,
    },
  });
}

/*
 * The mail a state change brought, read back and announced.
 *
 * Only a change that is not `FileNode` alone is a delivery: an upload, an
 * agent's document and the reader's own stored settings all wear `FileNode`,
 * which is the chat section's business and nobody else's. Any other name is read
 * rather than a whitelist of the two the bitmap is asked for, because which name
 * a degraded delivery wears is exactly what a live server has not been asked yet
 * (`ADR-0016 OWED: degraded-statechange-type`); a read that finds nothing says
 * nothing, so reading too widely costs requests, not noise.
 *
 * Where the account is one the briefing describes with an Inbox, the message is
 * read back and announced for real, which is what keeps a delivery from being
 * answered with the browser's own notice. Where there is no Inbox to read, and
 * where the read cannot be made at all (a session the worker does not have), the
 * notice names the mailbox it can rather than leaving the wake-up unanswered.
 *
 * What a read announces is gated by the watermark, because unread is not new:
 * with one, only what arrived after it is news; without one -- this device has
 * never announced anything for this account -- only what arrived within
 * `MAIL_FRESH_MS`, and the watermark is seeded from whatever the read saw. A
 * reader's standing unread mail is therefore never announced as it arrives. A
 * read holding nothing fresh notifies nothing, which is the one case the
 * browser's own notice still stands in for: the alternative is announcing mail
 * the reader has already been told about, or a change that was never a delivery
 * at all (a flag, a move) under a sentence saying it arrived.
 */
async function mailNotifications(changed, facts, strings) {
  const deliveries = Object.entries(changed).filter(
    ([, types]) => types && Object.keys(types).some((k) => k !== "FileNode"),
  );
  if (!deliveries.length) return;
  for (const [accountId] of deliveries) {
    const account = accountFact(facts, accountId);
    let messages = null;
    if (account?.inboxId) {
      try {
        messages = await newestUnread(accountId, account.inboxId);
      } catch {
        messages = null;
      }
    }
    if (messages === null) {
      await showMailNotice(accountId, account, strings);
      continue;
    }
    const newest = newestReceived(messages);
    const watermark = Date.parse((await readMailWatermarks())[accountId] ?? "");
    const seenFrom = Number.isFinite(watermark) ? watermark : Date.now() - MAIL_FRESH_MS;
    const fresh = messages.filter((email) => {
      const at = Date.parse(email.receivedAt ?? "");
      return Number.isFinite(at) && at > seenFrom;
    });
    if (!fresh.length) continue;
    try {
      for (const email of fresh) await notifyMail(accountId, account, email, strings);
      // The watermark moves past everything the read saw, not only past what was
      // announced: older unread mail is a backlog the worker leaves to the app
      // rather than one notice per message.
      await advanceMailWatermark(accountId, newest);
    } catch {
      /* the notification could not be shown: the watermark stays, so it retries */
    }
  }
}

/** The notice an account with nothing to read, or an unreadable one, is answered with. */
async function showMailNotice(accountId, account, strings) {
  await self.registration.showNotification(account?.name || strings.newMail, {
    body: strings.newMail,
    icon: `${BASE}/img/icon-192.png`,
    badge: `${BASE}/img/favicon-64.png`,
    tag: `gilbert-mail-${accountId}`,
    data: { url: `${BASE}/mail` },
  });
}

/** The newest `receivedAt` among these messages, as a number, or NaN for none. */
function newestReceived(messages) {
  return messages.reduce((newest, email) => {
    const at = Date.parse(email.receivedAt ?? "");
    return Number.isFinite(at) && at > newest ? at : newest;
  }, Number.NaN);
}

/* ------------------------------------------------------------------ */
/* Chat, which rides FileNode state changes                            */
/* ------------------------------------------------------------------ */

const FILE_NODE_CAP = "urn:ietf:params:jmap:filenode";
/* How many of a chat's newest nodes one wake-up reads back. */
const CHAT_READ = 10;

/*
 * The newest nodes of a chat folder.
 *
 * A real JMAP server pages `FileNode/query` by `position` and reports `total`,
 * so the newest page starts at `total - CHAT_READ`; the mock answers the same
 * shape. Asking for the total first is what lets a folder longer than the page
 * be read from its end rather than its start. This is ADR 0016's unverified
 * half: what a live 0.16 answers here is the probe `chat-wake-read` still
 * owes.
 */
async function newestChatNodes(accountId, folderId) {
  const using = ["urn:ietf:params:jmap:core", FILE_NODE_CAP];
  const counted = await jmap(
    [["FileNode/query", { accountId, filter: { parentId: folderId }, limit: 1 }, "q0"]],
    using,
  );
  const total = Number(counted?.methodResponses?.[0]?.[1]?.total ?? 0);
  if (!total) return [];
  const idsBody = await jmap(
    [
      [
        "FileNode/query",
        {
          accountId,
          filter: { parentId: folderId },
          position: Math.max(0, total - CHAT_READ),
          limit: CHAT_READ,
        },
        "q",
      ],
    ],
    using,
  );
  const ids = idsBody?.methodResponses?.[0]?.[1]?.ids;
  if (!Array.isArray(ids) || !ids.length) return [];
  const got = await jmap(
    [
      [
        "FileNode/get",
        { accountId, ids, properties: ["blobId", "nodeType", "created"] },
        "g",
      ],
    ],
    using,
  );
  const list = got?.methodResponses?.[0]?.[1]?.list;
  return Array.isArray(list) ? list : [];
}

/* Read one chat document through the same proxy a tab uses. */
async function readChatDoc(accountId, blobId) {
  const url = `${BASE}/api/blob/${encodeURIComponent(accountId)}/${encodeURIComponent(blobId)}/blob.txt?accept=application%2Fjson`;
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) return null;
  try {
    return JSON.parse(await res.text());
  } catch {
    return null;
  }
}

/*
 * Notify for the chat messages a state change brought, and say whether it did.
 *
 * A `FileNode` change is the only wake-up a chat message produces, and it
 * carries no message -- so the worker reads the chat folder back and announces
 * what is newer than the watermark the app wrote, from somebody other than the
 * reader. An account with no chat in the briefing is a wake-up that notifies
 * nothing, which is most file writes: an upload, an agent document, the
 * reader's own stored settings.
 */
async function chatNotifications(data, facts) {
  const accounts = (facts?.accounts ?? []).filter((a) => a.chatFolderId);
  if (!accounts.length || !data || data["@type"] !== "StateChange") return false;
  const changed = data.changed ?? {};
  let announced = false;
  for (const [accountId, types] of Object.entries(changed)) {
    if (!types || !("FileNode" in types)) continue;
    const account = accounts.find((a) => a.accountId === accountId);
    if (!account) continue;
    let nodes;
    try {
      nodes = await newestChatNodes(accountId, account.chatFolderId);
    } catch {
      continue; // a session the read cannot use notifies nothing
    }
    for (const node of nodes) {
      if (!node?.blobId) continue;
      const doc = await readChatDoc(accountId, node.blobId);
      const from = typeof doc?.from === "string" ? doc.from : "";
      const at = typeof doc?.at === "string" ? doc.at : "";
      const text = typeof doc?.text === "string" ? doc.text : "";
      if (!from || !at) continue;
      if (facts.ownAddress && from === facts.ownAddress) continue;
      if (account.watermark && at <= account.watermark) continue;
      await self.registration.showNotification(account.name, {
        body: `${from}: ${text}`.trim(),
        icon: `${BASE}/img/icon-192.png`,
        badge: `${BASE}/img/favicon-64.png`,
        tag: `gilbert-chat-${node.id}`,
        data: {
          url: account.inboxId
            ? `${BASE}/mail/${account.inboxId}${accountQuery(account.accountId)}`
            : `${BASE}/mail`,
        },
      });
      announced = true;
    }
  }
  return announced;
}

self.addEventListener("push", (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    /* not JSON: fall through to the generic notification below */
  }

  // The verification handshake, answered here so it settles with no tab open
  // and the server stops sending it.
  if (data && data["@type"] === "PushVerification") {
    event.waitUntil(verifyPushSubscription(data));
    return;
  }

  const emails =
    data && data["@type"] === "EmailPush" && Array.isArray(data.emails)
      ? data.emails
      : [];
  event.waitUntil(
    (async () => {
      /*
       * Someone reading the app already knows. A focused, visible window of
       * this app has its own event stream, so a notification on top of it is
       * the same news told twice. Chrome does not require one while the site
       * is in the foreground.
       */
      const windows = await self.clients.matchAll({ type: "window" });
      if (windows.some((w) => w.focused && w.visibilityState === "visible")) return;
      const facts = await readFacts();
      /*
       * What a tab has not written yet: the worker is installed and a push
       * arrives before the app has been opened once, which is the state the
       * first notification after installing always finds. English, because the
       * worker sits outside the catalogues -- the app hands it the reader's own
       * strings, in `facts.strings`, the first time it runs.
       */
      const strings = facts?.strings ?? {
        newMail: "New mail",
        newMessage: "New message",
        noSubject: "(no subject)",
      };
      /*
       * Mark the app icon, without claiming a number.
       *
       * `setAppBadge()` with no count shows a dot rather than a figure, which
       * is the only honest thing to show from here: a push carries the new mail
       * rather than a total, so counting the payload would badge "2" over an
       * inbox holding forty, and the count itself is a question the next tab
       * answers. `setUnreadBadge` writes the real count over the dot.
       */
      if ("setAppBadge" in self.navigator)
        await self.navigator.setAppBadge().catch(() => {});

      if (!emails.length) {
        const changed =
          data && data["@type"] === "StateChange" ? (data.changed ?? {}) : null;
        if (changed !== null) {
          /*
           * Two notification paths, one push, and they must not share a failure:
           * a chat read that cannot be made (its own `fetch` rejects) is the
           * chat's silence, not the mail's.
           */
          if (Object.values(changed).some((types) => types && "FileNode" in types)) {
            try {
              await chatNotifications(data, facts);
            } catch {
              /* the chat read failed: it notifies nothing, the mail still does */
            }
          }
          await mailNotifications(changed, facts, strings);
        }
        return;
      }
      /*
       * One delivery's `EmailPush`: the account it names is the reader's own or
       * a group mailbox, and its briefing entry carries the Inbox the link is
       * built from and the archive its button files to.
       */
      const deliveryAccountId =
        typeof data?.accountId === "string"
          ? data.accountId
          : (Object.keys(data?.changed ?? {})[0] ?? null);
      const account = accountFact(facts, deliveryAccountId);
      const announced = emails.slice(0, MAIL_MAX);
      for (const email of announced) {
        await notifyMail(deliveryAccountId, account, email, strings);
      }
      /*
       * A payload is news too, so it moves the same watermark the read-back
       * compares against: without this, the next payload-less change of the same
       * account would announce the message that has just been announced.
       */
      await advanceMailWatermark(deliveryAccountId, newestReceived(announced));
    })(),
  );
});

/*
 * Do what the button said, without opening anything.
 *
 * The whole point of an action is that the phone goes back in the pocket, so
 * this must not fall back to opening the app when the call fails -- that is
 * the same interruption the action existed to avoid. It re-notifies instead,
 * saying it did not happen, and leaves opening Gilbert to the reader.
 *
 * Archiving replaces the mailbox set rather than adding to it, which is what
 * archiving is: the message leaves the inbox. Marking read is a keyword and
 * touches nothing else.
 */
async function runAction(action, data) {
  const { id, accountId, archiveId } = data;
  if (!id || !accountId) return;
  const patch =
    action === "archive"
      ? { mailboxIds: { [archiveId]: true } }
      : { "keywords/$seen": true };
  try {
    if (action === "archive" && !archiveId) throw new Error("no archive mailbox");
    await jmap([["Email/set", { accountId, update: { [id]: patch } }, "0"]]);
  } catch {
    await self.registration.showNotification(data.title || "Gilbert", {
      body: data.failed ?? undefined,
      icon: `${BASE}/img/icon-192.png`,
      badge: `${BASE}/img/favicon-64.png`,
      tag: `gilbert-failed-${id}`,
      data: { url: data.url },
    });
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  if (event.action === "archive" || event.action === "read") {
    event.waitUntil(runAction(event.action, data));
    return;
  }
  const url = data.url || `${BASE}/mail`;
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        includeUncontrolled: true,
        type: "window",
      });
      // Reuse a tab if one is open rather than piling up windows. Same origin is
      // not enough under a prefix: `includeUncontrolled` widens the match to the
      // whole origin, so on a host that also serves something else this would
      // navigate a stranger's tab to our inbox.
      for (const c of clients) {
        const at = new URL(c.url);
        if (
          at.origin === self.location.origin &&
          (at.pathname === BASE || at.pathname.startsWith(`${BASE}/`))
        ) {
          await c.focus();
          if ("navigate" in c) await c.navigate(url).catch(() => {});
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
