# Architecture decision records — index

One file per decision (`NNNN-kebab-case-title.md`), numbered by the owner and
consecutively: a new record takes the number after the highest, so the
sequence has no gaps. A number is minted for a decision that is new, never for
a version of one already here.

A citation names a record that is a file here, and a section inside it is
named rather than numbered: the record's own structure is what a code
comment is read against.

Each record describes the decision as it stands and how it is built —
architecture, not a changelog. **A record is edited in place when the thing it
describes changes**, in the change that alters it: a later version of one
decision is the same file rewritten, so nothing here supersedes anything, no
record carries a `Superseded` status, and nothing narrates what used to be
true. A reader who wants the version before this commit asks git for it. The
one exception is the owner asking for otherwise, explicitly: only then does a
decision get a record beside the existing one instead of a rewrite of it.

Every record names the four blocks — **gilbertmailer**, **gilbertserver**,
**gilbertagents** and **gilbertstalwart** — the way `README.md` defines
them, so a decision and the product description use one vocabulary. What
Gilbert *does* is the inventory in `FEATURES.md` and the code itself; a
record here explains why a piece of the architecture is shaped the way it
is, not what a user sees.

## The decisions

- **0001 — Administration.** Gilbert admin is Stalwart admin: a principal is
  an administrator exactly when its permission list carries a configured
  marker, read fresh on every privileged call. Every privileged write into
  an account goes through impersonation; the installation policy, the
  identity lock and the forced-password directive are all per-account
  documents written that way.
- **0002 — Upstream is download-only.** Releases are fetched at merge time,
  nothing flows back, and no mirror branch is kept.
- **0003 — The agent fleet.** One installation-wide agent identity, its own
  process or embedded in the server, coordinated by lease documents with no
  supervisor. An automation is a trigger, a prose instruction and a capability
  allowlist, with the review policy carried once per group (ADR 0006); every
  run asks a model and the allowlist bounds what it may do. Covers the
  notebook, chaining, metering, the document tools, and the three-part admin
  surface (Master, Group Agents, Approvals).
- **0004 — A contact group is not a recipient.** A group card
  (`kind: "group"`, its `members` named by `uid`, no address of its own) is a
  client-side convenience over addresses: the composer's To/Cc/Bcc
  autocomplete, the recipient picker and the contact card's "Email group"
  action resolve it through one resolver, when it is chosen, into chips for the
  individual addresses — one per member, the preferred one — so the wire, the
  drafts and the replies never know a group exists. Resolved against every book
  the reader may read, a group mailbox's books among them; a member that cannot
  be resolved is skipped and counted; no nesting, and no threshold of its own.
- **0005 — Group chat and the group label catalog.** Both are layers on the
  group account's own JMAP Files, owned by the group from creation.
- **0006 — The minimal automation.** A group authors one enabled automation
  per trigger it uses — up to the four `AGENT_TRIGGERS`, never one
  per business case — and the count is enforced, because an automation carries
  no filter and nothing else tells two of them on one trigger apart: the save
  refuses a second, the editor offers only the triggers nothing holds, and the
  executor says so once if a document carries one anyway. A disabled automation
  is a draft and is allowed. The grant is chosen as three areas (Mail, Chat,
  Files and documents) instead of thirteen individual actions, and the
  expansion is computed from the catalogue — one tag per entry, minus anything
  marked `external` or `irreversible` — so a future flagged action leaves every
  area without a list being kept in step; `mail.send` is excluded from the area
  it belongs to and keeps its own entry, so ticking an area can never grant
  sending as a side effect. Doing nothing is not a permission but the absence of
  one, granted to every automation by `effectiveCapabilities`. How cautious a
  group's runs are is the **group's own policy document** rather than a field on
  every automation — two choices, no number, with the floors in code — and a
  group that has written none runs on the confident reading: an in-group action
  the model is sure of goes ahead, an unsure one stops for a person. New
  context belongs in one of two speeds — distilled into the group's notebook by
  an infrequent process, staying in the prompt's cached head, or fetched
  narrowly and by name into the volatile tail — never attached wholesale
  (a full mailbox, an unbounded document set), which would defeat the
  provider's own prompt caching and widen the untrusted-content surface at
  once. The one-automation-per-trigger rule, the areas, the policy and the two
  speeds of context — the notebook a run may write, and the named lookup it may
  ask for (ADR 0020) — are what the code does.
- **0007 — Identity administration.** An administrator sets a person's or a
  group's identity through the same doors impersonation and the agent
  already open; a locked account has no path of its own to change it, and the
  lock is about personal mailboxes only. Which identity a member sends as in
  a group is **an assignment the administration records** in the group's own
  app folder — next to the identity it writes, in the same action — and not a
  comparison of display names: the name is what a recipient reads, and a name
  that is also a key fails on any spelling, any rename and any name nobody
  set. A member with no assignment sends as **the group's own identity**, the
  one the agent sends as, and only a group holding no identity at all leaves
  the composer with nothing to offer.
- **0008 — System Sieve scripts.** An admin editor for Stalwart's own
  trusted, server-wide Sieve scripts — a JMAP registry object
  (`x:SieveSystemScript`), not an account's own script — written directly as
  the administrator's session, no impersonation, gated by a permission
  separate from Gilbert's admin marker. Shares its editor component with the
  personal "Scripts (advanced)" tab rather than duplicating one.
- **0009 — The push subscription covers every live type, at the request's
  own origin.** One subscription per account names every state type a
  Gilbert surface keeps live, and its callback address is derived from the
  request rather than configured.
- **0010 — The policy publish is a job with an id.** One id per publish,
  carried by every copy it writes, and the job — the population the
  directory reported, the accounts the policy reached, the ones it did not
  with a code each, and whether the installation can be said to carry the
  policy — is one document in the publishing administrator's own app
  folder. Every per-account write is conditional, and the outcome cannot
  claim more than it reached.
- **0011 — The installation's configuration is the Master's own document.**
  `installation.json` in the Master account's `gilbert` app folder, read
  whole at boot and written by the administration through the same
  impersonation door; the environment carries only the handshake, the
  container's and the image's own facts, the operator's own switch, and the
  facts about the process itself. A publish applies from the next boot.
- **0012 — A durable write is caused by a change, not by a clock.** Stalwart
  charges an account for every blob it uploads and never gives one back, so a
  write on a clock — a heartbeat, a renewed lease, a session's activity stamp —
  spends a finite budget saying that a process is alive. Liveness and activity
  are process facts (ADR 0003's claims, the sessions store), a write that would
  store what is already there is not made, and an idle installation therefore
  costs nothing.
- **0013 — A dropped name is written over, in place.** A drop or a picker
  selection lands on a name the folder already holds by writing the bytes into
  the node that holds it — same id, same sharing, same place in the tree, only
  `blobId`, `type` and `size` change — so dropping a tree twice is one tree.
  The create's `alreadyExists` refusal is what identifies that node, so no level
  is listed first; a name a **folder** holds stops the file instead of writing
  into it, and saving an attachment into Files still refuses a taken name rather
  than replacing one.
- **0014 — Merging two folders is planned before it is written.** Both trees are
  read, the plan is built, and any collision — a name that is a folder on one
  side and a file on the other, or a right the reader does not hold — stops
  every step with nothing written. The folder whose name the reader keeps is the
  node that survives; a name both hold as a file is written into in place (ADR
  0013) and its source node destroyed; the folder given up is destroyed last and
  only once it is empty, so a stopped merge leaves both folders standing. The
  entry is offered for exactly two folders and drawn always, disabled until the
  selection is one it can act on.
- **0015 — A group's mail is deleted by an administrator only.** A group mailbox
  is reached by membership rather than by a share, so the mail server tells one
  member's delete from another's by nothing and offers no rank inside a group;
  the rule is the client's. Moving, binning, labelling, archiving and forwarding
  all stay, and the three things that end a message for good — deleting it out
  of Deleted Items or Junk Mail, emptying one of those folders, and deleting a
  folder together with its mail — are refused for every member but an
  installation administrator, each refusal saying which one it is and what still
  works. It is a rule the product keeps, not a boundary: another client destroys
  the same mail.
- **0016 — What notifies a closed Gilbert.** A push subscription belongs to the
  principal that registered it and is served for every account that principal is
  a **member** of, so one row covers the reader's own mailbox and each of their
  groups — the group's mail already wakes a closed client today, as a
  notification that names nothing, and what it is owed is the per-account
  `emailPush` payload that names the sender, the subject and the mailbox it
  landed in. Chat rides the one vocabulary Stalwart has for a file: `FileNode`
  in the row's `types` wakes the service worker, which reads the message the
  app's watermark says it has not seen and stays quiet for its own. The
  notification permission is asked for in the reader's own gesture, iOS is
  answered with the install instruction rather than a switch that cannot work,
  and no sender of ours is introduced.
- **0017 — Administration is a door, not a menu.** The decision that a session
  may administer is made where the request is: the JMAP proxy refuses a body
  that names a registry object the session may not reach, behind an allowlist of
  the account's own objects, and every `/api/admin` route enforces the same two
  conditions — the installation offers administration (`server.administration`
  in its own document), and, where the installation asked for the rule, the
  session was signed in on a device marked as the person's own. The menu
  announces the decision and says why when it cannot; the server is the door.
- **0018 — A contact is moved between accounts by an administrator only.** A card
  is an object of one account and a group's card is the group's, so moving one
  across that line changes whose it is: the guard sits on the write
  (`moveCardTo`), the surfaces draw the entry from the same answer, and filing a
  new card into a group's book, editing one where it lives and re-filing a card
  inside one account are not moves and are unchanged.
- **0019 — The three levels of prose.** What an agent is told is written in
  three places, and they are one shape at three reaches: the **installation's
  own rules** (a document in the Master's account, written once in Admin →
  Master, carried into every call of every group), a **group's standing
  instruction** (the group's own account), and the **automation's own
  instruction** (a field of the rule, authored with the trigger it belongs to).
  They reach the model in that order — outermost first, after the capability
  catalogue and the group's notebook, before anything volatile — and one
  builder produces that order for both callers, a run's decision and an
  administrator's reading of a draft. None of them grants anything: the grant is
  the automation's capability allowlist, checked on every answer. The two
  documents are one type and one pair of readers, and the remarks that used to
  sit beside each of them — prose read by no model — are gone with them.
- **0020 — A run may look something up.** The deciding call may answer with a
  lookup from a closed catalogue instead of actions: the group's mail and its
  chat by the **search grammar the mail client already speaks**
  (`server/src/shared/search.ts`), one message or one file by the id/path a
  listing gave, its folders, its labels, and its visible Files one level deep or
  as a whole tree. The run performs the read in the group's own account, appends
  bounded results to the volatile tail and asks again, at most
  `AGENT_LOOKUP_ROUNDS` times. A listing is an index and a read is bounded, the
  system message is byte-identical across the calls so the provider's cache
  holds, the model writes a query and never a JMAP filter, a lookup writes no
  state, and the allowlist and the review gate are untouched: it is the named,
  narrow half of ADR 0006 decision three, with no per-question heuristic.
- **0021 — A group's folders are subscribed for every member.** A subscription
  is read state kept for one principal, and membership writes none of it: a
  member of a working group holds the whole tree unsubscribed, which is
  invisible inside `gilbertmailer` (a tree that is not the reader's own is drawn
  whole) and total everywhere else. So the client subscribes the folders its
  membership is about as it reads the tree — one idempotent write per folder
  that lacks it, on every read, never on the reader's own mailbox — and asks
  whose tree is on screen of the **session** rather than of the account probe,
  so a member's tree is whole from the first frame and whatever the probe
  answers later. A member may write that field — confirmed live on 0.16.23
  (2026-09-24).
- **0022 — Archive puts a conversation back where it was filed.** A reply
  arrives, joins the thread, and the conversation is back in the Inbox while the
  rest of it sits in the folder it was filed under — so the archive button
  returns it there, and only a conversation that was never filed anywhere goes
  to Archive. The newest filed message decides (that is where it was last put),
  Inbox/Sent/Drafts/Junk/Trash are not filing places, a message already in the
  destination is filed away as before, and every read and write is asked of the
  account the action is aimed at, because a group's copy of a conversation and
  the reader's own are two threads. The dated entries keep their literal
  meaning.
- **0023 — SIP telephony.** A browser cannot speak SIP, and a deployment's
  provider may not offer it over WebSocket, so the phone runs on **Janus** with
  its SIP plugin — a second process that ships with Gilbert (the image and the
  host installer both build it; one media UDP range is the only thing an
  operator opens). The browser attaches to the
  plugin, registers the account and negotiates the media, while Janus terminates
  the WebRTC and relays SIP and RTP; it never frames SIP, speaking the **Janus
  API** over a WebSocket gilbertserver proxies on its own origin and certificate
  and authenticates by session. Exactly one tab of one browser holds the line,
  seated by a **Web Lock** so every other tab shows no phone and the next waiting
  tab takes the seat and registers when the holder goes; the registration is the
  tab's, and the provider's own routing takes a call while none holds it. Audio
  only, G.711 passed through without transcoding, DTMF over RFC 2833, SIP over
  UDP to the provider, a STUN-only responder of the bridge's own and no TURN; the
  media range and the STUN port are the inbound ports and the SIP leg is
  outbound. A second call is refused 486 by the plugin. Each person's
  server, user name and password are account data, set in **Identities and SIP
  Phone** in the identity-enforcement surface and kept in the account's own
  `sip.json`; there is no installation-level phone configuration and no SIP Phone
  page, and the phone appears only where it can carry a call. The surface is
  **desktop only**: a page rings only while it is alive, and the dialer is
  read-only over Contacts separated by Global contacts, each group, personal and
  all, with a number typed by hand. Built.

- **0024 — Global contacts.** One address book in the Master's account, created
  by the installation rather than by hand, shared read-only with every account
  and written only by an administrator from inside Contacts through a server
  route that acts as the Master. It leads the Contacts sidebar, above
  `All contacts` and the reader's own books, as well as being merged in it; its
  cards are ordinary cards, and the phone offers them as speed dial. The exact
  Stalwart shape of a share naming every account at once is owed a live probe.
- **0025 — The knowledge base (proposed, a working record).** An enterprise
  knowledge base inside Gilbert, for people and for agents: a company-wide KB
  owned by the Master and shared, plus a KB per group owned by the group, over
  app-folder documents in Stalwart. An article has **one shared unapproved draft
  that users and agents both edit**, the fleet reviews it, and **only an
  administrator approves it into force with an effective date**, the revision it
  replaces staying in history as superseded. It takes the editor (BlockNote) and
  the search (Orama) off the shelf and builds the rest — storage, ownership,
  versioning, approval — itself, and makes the fleet a **document controller**
  that keeps policies aligned, finds inconsistencies and plans multi-document
  edits. The record is **Proposed** and deliberately a notebook: it carries the
  findings, the design as it stands, the lifecycle, versioning and publication
  (e.g. ISO 9001 policies), the library choice, and the questions still open,
  before any code exists.
- **0026 — One gate, and nothing merges or ships unverified.** The gate has one
  source — `npm run check:ci` — run by the pre-push hook and by the CI release
  pre-check, so the two cannot diverge; the action-pin rule is a check
  (`workflow:pin`) rather than a reviewer's memory; the dependency audit runs
  where a release is prepared, not on every push; a release is verified after it
  publishes, on both architectures and with `:latest` naming the same index; and
  a Dependabot pull request merges only on its CI run's green completion,
  through `workflow_run` so the token may write, merging the exact commit the CI
  verified. The procedure and the rollback are `docs/releasing.md`. Built.
- **0027 — Supply-chain scanning in CI.** What the one gate of ADR 0026 does not
  answer — a known-weak code pattern, a credential in the history — is a
  separate workflow (`ci-security.yml`), deliberately outside `check:ci`:
  Semgrep at ERROR level across the TypeScript, Node, security-audit and OWASP
  packs, and Gitleaks over the history through the official action pinned to a
  commit, with `.gitleaks.toml` for the project identifiers that are not
  secrets and `.semgrepignore` to point the SAST scan at the code that ships. A
  finding is work to do in the same change, and an allowlist entry is a positive
  proof rather than a silence. Built.
