# ADR 0005 — Group chat and the group label catalog

Status: Accepted

Implementation: Built. One JSON node per message and one read marker per member,
both in the group account (`web/src/lib/chat.ts`, `web/src/store/chat.ts`), with
the label catalog beside them (`web/src/store/groupLabels.ts`).

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
  offers them after an `@`. Who is offered is the group's own **roster**, read
  for the installation as the Master (`x:Account`, ADR 0003): asked once per
  conversation on `/api/agent/group/:name/members`, held for a minute, and
  every member is offered — whether or not they have ever written. The
  transcript is what stands in when no roster can be read: the addresses the
  loaded messages carry, which is what the picker offered before there was
  one, and the reason somebody who has left could be mentioned at all. A
  mention whose address the roster no longer lists renders **greyed** in the
  transcript — the words are what was written, and the style says the person
  they name is no longer here.
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

The chat launcher sits in the top bar, first item of the action cluster,
left of the push-status dot — a child of the same action group the avatar
anchors, not a free sibling after the search bar (whose flexible, centred
layout would otherwise leave an icon drifting in whitespace on wide
viewports). The bottom-right corner is the composer dock's, and the mobile
FAB and tab bar own the bottom edge, so neither is available to a chat
launcher.

- **Badge**: aggregated unread count on the launcher; per-conversation count
  inside the panel.
- **Panel**: a popover anchored under the launcher — a conversation switcher
  over the group accounts, the thread as bubbles, a text input at the
  bottom. It is transient by design, sitting below the composer dock's
  z-index and closing itself when a composer is maximised.
- **Mobile**: the launcher stays in the top bar; the panel becomes a
  full-screen sheet rather than a popover, and is not a sixth tab.
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
  could not ask" are different answers.
- **Shape.** An array of `Label` (`{ keyword, name, color, … }`), the same
  shape as personal `settings.labels`. The keyword is the stable identity
  that rides on messages; name, colour and nesting are display only, so
  renaming a label rewrites nothing in the mailbox.
- **Who does what.** Members read the catalog and apply or remove labels
  through their own session (`Email/set` keywords) — no impersonation
  needed. An administrator defines or changes the catalog itself from the
  admin surface, and that write goes through the same door every write into
  a group's files uses: as the installation's agent, via the deployment's
  credential or impersonation from the administrator's session. A deployment
  with no usable agent therefore has no group catalog administration, and
  the surface says exactly that (`agent_not_configured`) rather than a
  permission error.
- **Effective catalog.** Browsing a group mailbox always uses the group's
  own catalog; a reader's personal labels stay personal.
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
- `server/src/agentAdmin.ts` — `memberGroupMembers`, and the roster read
  behind it (`groupMembers`)
- `scripts/probe-group-membership.mjs` — the live probe of the registry read
- `server/src/push.ts` — the per-account push relay this rides
- ADR 0001 — the admin group and impersonation
- ADR 0003 — the agent as the write door into a group's own documents
