# ADR 0005 — Group chat on the group's own Files

Status: Accepted (2026-09-08)

## Context

Groups (team mailboxes such as `freight@…`) are Stalwart principals whose
members reach the group's own account through their JMAP session. Product law
in this repository says everything a group owns lives in the group's own
account, owned by the group from creation — calendars, address books and task
lists follow it (ADR 0001's admin group excepted), and chat must not become
the exception that tasks, calendars and contacts used to be before they were
aligned: objects created in a member's personal account and shared out to the
group require per-object ACL maintenance and never cover a member added after
the fact.

The members want a text chat for each group: only members, only text with
emoticons, no attachments, durable across sessions, with an unread ("da
leggere") surface, and a transcript a member added later can read from the
start.

Live updates today are a JMAP push subscription per account (`server/src/
push.ts`) with `types: [Email, Mailbox, Thread, Identity, EmailSubmission,
VacationResponse]`; the browser receives StateChange events and re-syncs the
affected types. Nothing in that machinery watches Files.

## Decision

Group chat is a layer on the **group account's own JMAP Files**, one JSON
document per message, with the group as owner from the first second.

- **Where it lives.** In the group account's `gilbert` app folder (the one the
  Files UI hides, exactly like the per-account settings folder): a `chat`
  folder of immutable message documents and a `chat-state` folder of per-member
  read markers. The account that owns them is the group's own account — no
  personal-account copy, no `shareWith`, no ACL maintenance. Membership is the
  grant: a member's session on the group account can read and write them; a
  non-member has no session on that account; a member who leaves loses access
  and a member who returns (or joins later) sees the transcript and their own
  marker still there.
- **Message document.** One immutable `FileNode` per message in `chat`,
  `content-type: application/json`: `{ "v": 1, "from": <member address>,
  "at": <ISO timestamp>, "text": "…", "replyTo": <message id>? }`. Text
  only — no blob, no attachment path; the UI renders it as plain text (React
  escaping; emoticons are text). A length bound (4000 characters) keeps
  documents small. Mentions in v1 are a rendering nicety over the text, not
  structured data.
- **Quote reply.** A reply may carry the optional `replyTo` id of the message
  it answers — another member's or the sender's own, WhatsApp-style. The
  client renders a quoted snippet (sender + text) above the reply by looking
  the id up in the transcript, and the composer shows the message being
  answered while one is being written. Messages are immutable in v1, so an id
  reference stays resolvable for as long as the chat does.
- **Read markers.** One document per member in `chat-state`,
  `read-<member>.json`, written by that member's own session, holding the
  last-read position. Markers are group-owned data named per member (everything
  of the group lives in the group), shared across the member's devices, and a
  member overwriting another member's marker is a benign non-boundary (worst
  case: someone's "last read" moves; the UI never exposes it).
- **Unread semantics (kind rule).** Unread = messages newer than my marker.
  A member with no marker sees badge 0 and the full transcript; the marker is
  born at first open, from then on only newer messages count. A member added
  later reads the whole transcript without an unread flood.
- **Real-time.** A `PushSubscription` with `types: ["FileNode"]` (a second
  subscription beside the mail one, or FileNode added where a chat account
  needs it — a design detail settled at implementation) makes Stalwart POST
  StateChange events for FileNode to the existing relay; the browser reacts to
  a FileNode StateChange for an account by running `FileNode/changes` and
  fetching the new message documents. Verified live on the 0.16 server at
  the owner's test instance (2026-09-07): `FileNode/set` advances state, `FileNode/
  changes` reports created ids from `sinceState`, `?types=FileNode` on the
  event source delivers `{"@type":"StateChange","changed":{<account>:
  {"FileNode": …}}}`, and `PushSubscription/set` accepts `types:
  ["FileNode"]`. The same mechanics are present in the Stalwart source at tag
  v0.16.19 (`DataType::FileNode`, per-subscription `filter_types`).
- **Ordering.** Messages are ordered by the server-side creation order of
  their FileNodes; whether that is carried by an explicit timestamp property
  or by id is verified live before implementation (see below) and the mock is
  kept in step.
- **UI placement and shape** (detailed below). The launcher is offered only
  when the session holds group mailboxes (the probed mail accounts), and the
  product-admin group is excluded: it is an administration surface, not a
  working group (ADR 0001).

### UI placement and shape

The chat is a glance-and-reply surface, so it lives in the top bar rather
than anywhere a persistent work area sits.

- **Launcher: top bar, first item of the action cluster** — immediately left
  of the push-status dot, before Help/theme/admin/settings and the account
  avatar. It is a child of `topbar-actions`, not a free sibling after the
  search bar: the search bar is centred and flexible (up to 720 px, `margin:
  0 auto`), so an icon placed after it would drift in whitespace on wide
  viewports. The avatar stays the corner anchor — its menu popover opens
  `align="end"`, and nothing sits to its right. On mobile the dot and Help
  are hidden (`hide-mobile`), so the launcher keeps the same first slot.
- **Why not bottom-right.** The composer dock owns that corner
  (`.composer-dock { position: fixed; right: 16px; bottom: 0 }`, with
  multiple docked windows) and on mobile the FAB and the five-slot tab bar
  own the bottom edge. A chat bubble there would fight the composer for the
  corner; the top bar has no such owner.
- **Badge**: aggregated unread count over all group conversations on the
  launcher; per-thread count inside the panel.
- **Panel**: a popover (the existing `.popover` shape, 360–400 px wide, max
  height 70 vh) anchored under the launcher: a conversation switcher over
  the group accounts at the top, the thread as bubbles (mine right, others'
  left), a text input at the bottom. It is transient by design: covering
  part of the reading pane while it is open is fine for a glance-and-reply
  surface, while the composer is a persistent work area — the panel's
  z-index sits below the composer dock's, and the panel closes itself when a
  composer is maximised (a maximised composer covers nearly the whole
  viewport).
- **Mobile**: the launcher stays in the top bar; the panel becomes a
  full-screen sheet (slide-up) instead of a popover — a 360 px popover does
  not fit under a top-right anchor on a phone viewport. It is not a sixth
  tab: the mobile tab bar is a full five-slot grid.
- **Collapsed state is device-local** (localStorage, a UI cache only),
  following the settings rule that account data lives in Stalwart.
- **Escape hatch, not v1**: the conversation component is designed reusable
  so a future full-screen "chat" view can embed it; v1 ships the panel
  only.

## Consequences

- **Ownership is structural.** A message document belongs to the group by
  construction, exactly like the group calendars, address books and task
  lists; there is nothing to migrate when membership changes.
- **Real-time rides an existing rail.** The push subscription, the relay and
  the changes engine already exist; only the FileNode type is new to them.
- **Chat data is mail-server data.** It is visible to any JMAP client acting
  on the group account and readable by the account's own tools; it is not a
  private side channel, and the client must not imply otherwise.
- **Growth is append-only and unbounded by design in v1.** No deletion or
  moderation surface exists; a group that wants to retire a chat clears the
  chat folders through Files. Acceptable for v1; revisit only if chat becomes
  archival.
- **No attachments, no typing indicator, no presence.** These are IM
  semantics Stalwart does not model; the chat is honest about being a durable
  group conversation, not an instant messenger.
- **Mock parity.** `server/src/mock` must reproduce FileNode state/changes
  well enough that the chat store's re-sync path is tested; the parity comment
  convention applies.

## Alternatives considered

- **Floating chat bubble, bottom-right**: rejected — the composer dock owns
  that corner (fixed, `right: 16px; bottom: 0`, several windows) and the
  mobile FAB sits above the tab bar on the same side; the chat would fight
  the composer for the corner.
- **Floating bubble, bottom-left**: not chosen — the left column is the
  folder tree, and on mobile the bottom edge belongs to the five-slot tab
  bar; it also abandons the corner convention users expect of a chat
  launcher.
- **Right-edge dock (app-style rail)**: deferred — it would overlay the
  reading pane for as long as it is open, a heavier intrusion than the
  glance-and-reply popover needs; kept as the shape of a future full-screen
  view.
- **Launcher to the right of the account avatar**: rejected — the avatar is
  the corner anchor (its menu popover aligns to the screen edge), and
  communication icons belong left of the account cluster, never beyond it.

## Open questions (recorded, not blocking v1)

1. Member writes into the group account's `gilbert` folder via FileNode/set
   (ACL on a shared account's Files) — expected per the calendar/book probes
   already done on freight (2026-09-07), but not yet exercised for the app
   folder of a group.
2. Which FileNode property carries reliable creation order (timestamp vs id).
3. Whether the second subscription should be per chat account or FileNode
   added to the existing one, and the volume cost of the latter (every
   settings.json save in a subscribed account would also POST).

## Group label catalog (email)

The same "group's own Files" rule covers the label catalog of a group
mailbox (owner direction 2026-09-09): the labels that name a group's messages
belong to the group, not to any member.

- **Where it lives.** `labels.json` in the group account's own `gilbert` app
  folder, beside the chat folders — the group is the owner from the start,
  membership is the grant, no `shareWith`, no ACL maintenance.
- **Shape.** An array of `Label` (`{ keyword, name, color, … }`), the same
  shape as the personal `settings.labels`. The keyword is the stable identity
  that rides on the messages; name, colour and nesting are display only.
  Renaming a label therefore changes only the name — nothing in the mailbox
  is rewritten, so there are no stale keywords by construction.
- **Who does what.** Members read the catalog and apply or remove labels
  through their own session on the group account (plain `Email/set` keywords)
  — no impersonation, no extra privilege. Only an administrator defines or
  changes the catalog, from the admin surface, through the existing
  impersonation write (the same grant forced-password uses); an administrator
  who is a member of that group needs no impersonation.
- **Effective catalog.** Browsing a group mailbox uses the group's own
  catalog, never the reader's personal labels; the reader's own mailbox keeps
  the personal labels.
- **Real-time.** `labels.json` is a FileNode, so a catalog edit rides the
  existing FileNode push rail and re-reads on the members' side; keyword
  changes on messages ride the Email push rail. Both are already the live
  mechanisms.

## References

- Supersedes: none. Related: ADR 0001 (admin group; ownership of group data),
  ADR 0004 (per-account app folder pattern).
- Stalwart source @ tag v0.16.19: `crates/types/src/type_state.rs`
  (`DataType::FileNode`), `crates/services/src/state_manager/push.rs`
  (per-subscription type filter), `crates/jmap/src/api/event_source.rs`
  (types query parameter), `tests/src/jmap/files/node.rs` (FileNode changes).
- `server/src/push.ts` — per-account PushSubscription relay.
- Live probe on the owner's test instance (2026-09-07): FileNode state on set,
  FileNode/changes from `sinceState`, `?types=FileNode` StateChange delivery,
  PushSubscription/set accepting `types: ["FileNode"]`.
