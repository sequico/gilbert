/* gilbert service worker.
   Two jobs: app-shell caching for installability and fast loads (API requests
   are never cached), and Web Push, which is the only part of gilbert that runs
   when no tab is open. */
const VERSION = "gilbert-v3";

/*
 * The name of the shell cache, and the lever that refreshes it.
 *
 * `install` fills this cache from SHELL and `activate` deletes every cache
 * whose name is not this one. A browser only runs `install` again when this
 * file's own bytes changed, so an asset listed in SHELL that changed while
 * this file did not -- an icon, the manifest -- stays at its old copy in the
 * cache, and offline loads keep serving it. Bumping the string is what makes
 * the shell be fetched again.
 *
 * `web/src/lib/swCache.ts` carries the same name on the app's side; the two
 * have to match for a push verification or a share to be found. Nothing in the
 * build makes them agree, so a test does (`lib/__tests__/swCache.test.ts`).
 */

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
    caches
      .open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

/*
 * Where a share from the operating system is left for a tab to collect.
 *
 * Absolute and anchored to the mount, for the same reason the verification key
 * below is: a relative key is resolved against the URL of whoever asks, and the
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
    const cache = await caches.open(VERSION);
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
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
            return res;
          }),
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
           */
          if ((res.headers.get("content-type") ?? "").startsWith("text/html"))
            event.waitUntil(refreshShell(res.clone()));
          return res;
        })
        .catch(() => caches.match(SHELL_KEY)),
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
 * A JMAP subscription also delivers a PushVerification first, and stays silent
 * until the client echoes its code back. It is stashed for a tab to confirm
 * rather than answered here — on the same reasoning, and because a
 * verification that failed silently would leave push looking broken with
 * nothing to show for it. Answering it directly is now possible and is worth
 * revisiting.
 */

/*
 * Absolute, and anchored to the mount rather than to whatever page happens to
 * be open.
 *
 * A relative key is resolved against the URL of whoever is asking: the worker
 * lives at `<base>/sw.js`, so it stored this under `<base>/…`, while a tab at
 * `/mail/inbox/abc` looked for it under `/mail/inbox/…`. The two only ever
 * agreed when the open page was the root, so a verification code that arrived
 * with no tab open was written where the next tab would not look -- and the
 * subscription stayed silent, which is the same thing push failing looks like.
 */
const VERIFY_KEY = `${BASE}/gilbert-push-verification`;

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
    const hit = await (await caches.open(VERSION)).match(FACTS_KEY);
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
          url: account.inboxId ? `${BASE}/mail/${account.inboxId}` : `${BASE}/mail`,
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

  // The verification handshake. No credentials here, so hand it to a tab —
  // an open one now, or the next one to start.
  if (data && data["@type"] === "PushVerification") {
    event.waitUntil(
      (async () => {
        const payload = { id: data.pushSubscriptionId, code: data.verificationCode };
        const clients = await self.clients.matchAll({
          includeUncontrolled: true,
          type: "window",
        });
        if (clients.length) {
          for (const c of clients)
            c.postMessage({ type: "push-verification", ...payload });
        } else {
          const cache = await caches.open(VERSION);
          await cache.put(VERIFY_KEY, new Response(JSON.stringify(payload)));
        }
      })(),
    );
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
          if (Object.values(changed).some((types) => types && "FileNode" in types))
            await chatNotifications(data, facts);
          /*
           * Only an account the briefing lists **without** an Inbox is
           * announced here. The subscription's `emailPush` map describes every
           * account whose Inbox is known, and its delivery arrives as the
           * `EmailPush` below; the state change that rides beside it is the
           * duplicate and says nothing. An account with no Inbox has no entry,
           * so its delivery arrives only as this state change -- and the
           * briefing can name it.
           */
          const target = Object.entries(changed).find(([id, types]) => {
            const account = accountFact(facts, id);
            if (!account || account.inboxId) return false;
            // A FileNode change is never mail: the reader's own settings write,
            // an upload, an agent document. Any other type is a delivery.
            return types && Object.keys(types).some((k) => k !== "FileNode");
          });
          if (target) {
            const account = accountFact(facts, target[0]);
            await self.registration.showNotification(account.name || strings.newMail, {
              body: strings.newMail,
              icon: `${BASE}/img/icon-192.png`,
              badge: `${BASE}/img/favicon-64.png`,
              tag: `gilbert-mail-${account.accountId}`,
              data: { url: `${BASE}/mail` },
            });
          }
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
      // One notification per message, collapsing repeats of the same message by
      // tag so a re-push does not stack.
      for (const email of emails.slice(0, 5)) {
        const { title, body, preview } = textOf(email, strings);
        // A group's message is titled with the group as well as the sender, so
        // a lock screen names both.
        const heading =
          account && !account.own && account.name ? `${title} · ${account.name}` : title;
        await self.registration.showNotification(heading, {
          body: preview ? `${body}\n${preview}` : body,
          icon: `${BASE}/img/icon-192.png`,
          badge: `${BASE}/img/favicon-64.png`,
          tag: `gilbert-${email.id || body}`,
          // Only where there is a message to act on: a payload without an id can
          // be shown but not archived, and a button that cannot work should not
          // be drawn.
          actions: email.id ? actionsFor(account, strings) : [],
          data: {
            /*
             * The route is `/mail/<mailbox id>/<thread id>`, so the link needs
             * the account's real Inbox id and the message's thread id -- never
             * the literal `inbox` or the message's own id, neither of which the
             * app can resolve (it answers "that folder no longer exists").
             * Without a known Inbox, open /mail and let it redirect.
             */
            url: account?.inboxId
              ? email.threadId
                ? `${BASE}/mail/${account.inboxId}/${email.threadId}`
                : `${BASE}/mail/${account.inboxId}`
              : `${BASE}/mail`,
            id: email.id || null,
            title,
            accountId: deliveryAccountId,
            archiveId: account?.archiveId ?? null,
            failed: strings.failed ?? null,
          },
        });
      }
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
