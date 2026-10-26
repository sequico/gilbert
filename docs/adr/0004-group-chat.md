# ADR 0004 — Group chat and the group label catalog

Status: Accepted

Implementation: Built. One JSON node per message and one read marker per member,
both in the group account (`web/src/lib/chat.ts`, `web/src/store/chat.ts`), with
the label catalog beside them (`web/src/store/groupLabels.ts`) and the reserved
`G-` labels rendered from the shared vocabulary, never from the catalog
(`server/src/shared/labels.ts`, `web/src/lib/agentLabels.ts`).

Groups (team mailboxes such as `freight@…`) are Stalwart principals whose
members reach the group's own account through their own JMAP session.
Product rule: everything a group owns lives in the group's own account, owned
by the group from creation — calendars, address books and files all
follow it, and chat and labels are no exception. An object created in a
member's personal account and shared out to the group would need per-object
ACL maintenance and would never cover a member added later; nothing here
works that way.

## Chat

Chat is a layer on the group account's own JMAP Files: one JSON document per
message, owned by the group from the first second. It lives in the group's
hidden `gilbert` app folder — the one the Files view already hides — in a
`chat` folder of immutable message documents and a `chat-state` folder of
per-member read markers. Membership is the grant: a member's session on the
group account can read and write them, a non-member has no session there,
and a member who leaves and returns finds the transcript and their own
marker unchanged.

- **Message document** (`server/src/shared/chat.ts`): one immutable file per
  message, `{ "v": 1, "from": <member address>, "at": <ISO timestamp>,
  "text": "…", "replyTo": <message id>? }`, text only — no attachment path,
  rendered as plain text with React escaping. A 4000-character bound
  (`MAX_TEXT`) keeps documents small.
- **Quote reply**: a message may carry the optional `replyTo` id of the one
  it answers; the client renders a quoted snippet by looking that id up in
  the transcript. Messages are immutable, so the reference stays resolvable
  for as long as the chat does.
- **Mentions, and who may be offered one**: a message may name members
  (`"mentions": [{ "kind": "principal", "id": <address> }]`), and the composer
  offers them after an `@`. Who is offered is the **transcript**: everybody who
  has posted in this conversation, plus the reader. The group's roster is not
  read here, so a member who has never written is not offered, and somebody who
  has left stays offerable for as long as their messages do — the words are
  what was written, and the transcript is the group's.
- **Who a message is for** (owner decision 2026-10-22): a message with **no
  mention** is the group agent's work, and so is one that names the agent. A
  message that names **another person** is theirs and the agent stays out of it;
  one that names both is still the agent's. The mention is either the stored
  mark or the name typed out (`@sam`), so a client that records no mark cannot
  turn a conversation between people into the agent's. The rule is
  `addressedToAgent` (`server/src/shared/chat.ts`), read by the agent's wake and
  by the switched-off notice.
- **Read markers**: one document per member (`read-<member>.json`), written
  by that member's own session, holding the last-read position. A member
  with no marker sees the full transcript and no unread badge; the marker is
  born at first open. Markers are shared across a member's devices, and one
  member overwriting another's is a harmless non-boundary the UI never
  exposes.
- **Real-time**: a `PushSubscription` covering `FileNode` for chat-capable
  accounts makes Stalwart POST StateChange events to the existing relay; the
  browser reacts by fetching new message documents via `FileNode/changes`.
- **Ordering**: by the server-side creation order of the FileNodes.

### Placement

The chat launcher sits in the top bar, first item of the action cluster, a
child of the same action group the avatar anchors, not a free sibling after the
search bar (whose flexible, centred
layout would otherwise leave an icon drifting in whitespace on wide
viewports). The bottom-right corner is the composer dock's, and the mobile
FAB and tab bar own the bottom edge, so neither is available to a chat
launcher.

- **Badge**: aggregated unread count on the launcher; per-conversation count
  inside the panel.
- **Panel**: a popover anchored under the launcher — a conversation switcher
  over the group accounts, the thread as bubbles, a text input at the
  bottom. It is transient by design, sitting below the composer dock's
  z-index and closing itself when a composer is maximised; on a phone, where
  every open composer is full-screen, any open composer closes it.
- **Mobile**: the launcher stays in the top bar; the panel becomes a sheet in
  the content area rather than a popover — portaled to the body so the top
  bar's stacking context cannot trap it, and spanning only from the top bar's
  foot to the tab bar's head, so the menu and the module tabs stay reachable
  and the message field sits above the tab bar. It is not a sixth tab.
- **Collapsed state** is device-local (`localStorage`), since it is UI
  preference, not account data.

### What chat is not

There are no attachments, no typing indicator and no presence — semantics
Stalwart does not model. Growth is append-only and unbounded; a group that
wants to retire a chat clears the chat folders through Files. Chat data is
ordinary mail-server data: visible to any JMAP client acting on the group
account, not a private side channel.

## Group label catalog

The same group-owns-its-data rule covers the label catalog of a group
mailbox: the labels that name a group's messages belong to the group, not to
any member.

- **Where it lives.** `labels.json` in the group account's own `gilbert` app
  folder, beside the chat folders.
- **What counts as a group.** An account that answers `Mailbox/get` with a
  folder tree is a group; one that answers with none is a share. The rule
  lives once, on the server (`groupAccounts`), and once in the client's own
  mailbox probe, so both sides classify an account the same way. An account
  that cannot be probed is not treated as a group, and the probe's own
  failure is logged rather than swallowed — "this is not a group" and "I
  could not ask" are different answers. Confirmed live on 0.16.23
  (2026-09-24): a group mailbox answers the probe with a folder tree while the
  member's own account is not a candidate (`scripts/probe-group-classifier.mjs`);
  a share account was not in that session, so the no-mailboxes half was not
  asked.
- **Shape.** An array of `Label` (`{ keyword, name, color, … }`), the same
  shape as personal `settings.labels`. The keyword is the stable identity
  that rides on messages; name, colour and nesting are display only, so
  renaming a label rewrites nothing in the mailbox.
- **Who does what.** Members read the catalog and apply or remove labels
  through their own session (`Email/set` keywords) — no impersonation
  needed. An administrator defines or changes the catalog itself from the
  admin surface, and that write goes through the same door every write into
  a group's files uses: as the **Master**, via the deployment's credential or
  impersonation from the administrator's session. A deployment that cannot reach
  the Master therefore has no group catalog administration, and
  the surface says exactly that (`agent_not_configured`) rather than a
  permission error.
- **Effective catalog.** Browsing a group mailbox always uses the group's
  own catalog; a reader's personal labels stay personal.
- **The reserved labels.** `G-` is the product's own namespace, never a group's
  and never an entry in a group's catalog: the states the agent marks a message
  with are named in code (`server/src/shared/labels.ts`, `AGENT_LABELS`), and
  the client renders them from there — on the individual message, kept out of
  the manual picker and never aggregated onto a thread row. Applying one is the
  **agent's** act (ADR 0028 class 1), not a member's, and the catalog's own
  write refuses the namespace, so a group's `labels.json` can only ever hold its
  human labels.
- **The surface.** Where a group's labels are drawn, the two namespaces are two
  sections: **Labels**, the group's own catalog, and **System labels**, the
  reserved `G-` ones, whose entries come from `AGENT_LABELS` and never from a
  catalog. In the administration the catalog is edited and the reserved section
  is read-only — it draws no add, rename, colour or delete control — and a read
  drops a reserved entry an older document still carries, which is a residue of
  a surface that no longer exists rather than something a reader is asked to
  repair. In the mail client's
  own label block (`views/mail/MailboxTree.tsx`) the reserved section is drawn
  for a group's account, as filter rows carrying the counts the other labels
  carry — through `countedKeywords`, never through `labelsForAccount`, so no
  reserved keyword reaches the picker, a thread row or the catalog's own counts.
  A person's own
  label surface (`views/settings/LabelsSettings.tsx`) shows only the one section,
  the personal labels, and its catalog is not guarded against the namespace: the
  reserved labels name the agent's work, and a person's account has none of it
  (ADR 0038), so a keyword typed there names their own message and no agent is
  there to confuse it with one of its own.
- **Real-time.** `labels.json` is a FileNode, so a catalog edit rides the
  same push rail chat does; keyword changes on messages ride the Email push
  rail.

## Consequences

- Ownership is structural: a message or label document belongs to the group
  by construction, exactly like its calendars and address books, so nothing
  needs migrating when membership changes.
- Real-time rides an existing rail — only the `FileNode` type is new to the
  push subscription and the relay.
- Chat and labels are mail-server data: visible to any JMAP client on the
  group account, never a private channel the product should imply otherwise
  about.
- A mention is a name in a document and nothing beside it: it carries no
  delivery of its own, so the roster decides what a writer is offered and
  never who is told. Somebody who has left keeps every message they wrote —
  the transcript is the group's — and loses only the offer.

## References

- `server/src/shared/chat.ts` — message and marker document shapes, and the
  offerable set (`mentionablesOf`)
- `web/src/views/chat/ChatPanel.tsx`, `web/src/store/chat.ts` — the UI and
  store
- `scripts/probe-group-membership.mjs` — the live probe of the registry read
- `server/src/push.ts` — the per-account push relay this rides
- ADR 0001 — the admin group and impersonation
