# Features

What Gilbert is, in one paragraph, is the top of [README.md](README.md); what it
is *for* — operations rather than sales, deliberately no CRM and no sales
functions — is [there too](README.md#who-it-is-for). This is the inventory
of everything it does, ordered the way the project cares about it: **Gilbert's
own** first — the groups, the chat and above all the agents — and the client the
mail core derives from after it.

[ROADMAP.md](ROADMAP.md) is what Gilbert deliberately does **not** do and why;
[KNOWN-ISSUES.md](KNOWN-ISSUES.md) is what was verified live and where Stalwart
departs from a spec. Gilbert targets Stalwart **0.16** or newer and refuses older
servers at sign-in, by name; the tree is followed against **0.16.22**.

## The shape of it

A single-page React app plus a small Node server that speaks JMAP to Stalwart on
the browser's behalf. No IMAP, no SMTP, no database, no search index, no cache
tier. Every durable thing — mail, calendars, contacts, files, filters and
Gilbert's own settings — lives in the mail store. The container is disposable,
and with `IMMUTABLE=1` it has nothing writable at all.

Everything belongs to one of four blocks — **gilbertmailer**, **gilbertserver**,
**gilbertagents** and **gilbertstalwart** — defined in `README.md`, the only
place they are defined. `gilbertmailer`, and inside `gilbertserver` the layer
that serves it, came from upstream; everything else is Gilbert's own.

### Capabilities, and what happens without them

Features are gated on what the server advertises, one by one, and a missing
capability removes its feature rather than breaking the app.

| Capability | Powers | Missing |
| --- | --- | --- |
| `urn:ietf:params:jmap:core` | Everything | Nothing works; sign-in fails |
| `urn:ietf:params:jmap:mail` | Mail, folders, labels, search, drafts | No mail views |
| `urn:ietf:params:jmap:submission` | Sending | Compose is read/save only |
| `urn:ietf:params:jmap:submission` + `futureRelease` (per-account) | Scheduled send | The clock button is not offered |
| `urn:ietf:params:jmap:vacationresponse` | Out of office | The Settings section hides |
| `urn:ietf:params:jmap:sieve` | Filters, visual and raw | Filters hides |
| `urn:ietf:params:jmap:contacts` (+`:parse`) | Contacts; vCard import | Contacts hides; import only needs `parse` |
| `urn:ietf:params:jmap:calendars` (+`:parse`) | Calendar; iTIP invitations in mail; iCal import | Calendar hides; invite cards and import need `parse` |
| `urn:ietf:params:jmap:principals` | Directory lookup, sharing pickers | Sharing and directory autocomplete step aside |
| `urn:ietf:params:jmap:principals:availability` | Free/busy when scheduling | Guests show no availability |
| `urn:ietf:params:jmap:quota` | Storage bar under the folder list | The bar is not drawn |
| `urn:ietf:params:jmap:blob` | Attachments, message source, vCards, signature images | Downloads and uploads degrade |
| `urn:ietf:params:jmap:filenode` | Files, attach-from-Files, **synced settings** | Files hides; settings fall back to this browser |
| `urn:ietf:params:jmap:webpush-vapid` | Notifications with Gilbert closed | Only in-tab notifications |
| `urn:ietf:params:jmap:emailpush` | Sender and subject inside a push payload | Push says "new mail" and nothing more |
| `urn:stalwart:jmap` (per-account) | Password change, app passwords, 2FA state | **Sign-in is refused** — this is the 0.16 check |
| EventSource push | Live updates | Falls back to polling |
| Push subscription fan-out | Live updates without one upstream stream per tab; the callback origin is derived from the request behind a trusted https proxy; a change re-reads what is on screen, not every listing opened | Falls back to the EventSource relay |

`urn:stalwart:jmap` is advertised per **account**, not session-wide, and the
submission capability keeps `futureRelease` in the same place. Both are read out
of `accountCapabilities`; reading them at the top level silently disables the
feature, which is why the mock reproduces the per-account shape.

---

# Gilbert's own

Gilbert is a product built on Stalwart rather than a mail client with extras
bolted on. The **group** is the unit everything else is built around: a group
mailbox is an account of its own, and what it owns — its chat, its label catalog,
its calendars and files, its agent's documents — lives in that account and
belongs to it from creation, shared with its members rather than copied to them.
**Chat** is one conversation per group. **Agents** is the largest part: a fleet
that acts inside mail and file storage on a group's behalf.

The one thing a member cannot do with group-owned mail is **end it**: the mail
server tells one member's delete from another's by nothing and offers no rank
inside a group, so the refusal is this client's rule, and ending a message — out
of Deleted Items or Junk Mail, by emptying either, or by deleting a folder with
its mail — is an installation administrator's decision (ADR 0015). Everything
else a member does to move mail around still works.

# Agents

Gilbert's own agents: a Stalwart account of its own — a *structure agent*, e.g.
`gilbert@…` — that acts inside mail and file storage for the groups the operator
has granted it (ADR 0003). For the full design, see
[docs/adr/0003-agent-fleet.md](docs/adr/0003-agent-fleet.md); the inventory is:

- **The agent is a mailbox**, an ordinary Stalwart account created by the operator
  and **granted** on a group like any principal. Membership is the grant: no
  in-product activation switch, so a visible group is one it works for. The admin
  surface reads that membership from the Master's session and shows it; it never
  writes one.
- **The agent's address and password are the deployment's**:
  `GILBERT_AGENT_ADDRESS` and `GILBERT_AGENT_PASSWORD` (the account's own
  password, never an app password), in the environment of whoever starts the
  server and the agent. The pair lives only in the deployment; neither process
  records it. Absent or incomplete, the boot names the missing variable and exits.
  **Admin → Master** reports the state it finds; an agent started with nothing
  named warns once, keeps running and serves nothing.
- **What the fleet serves, per group**: the accounts Stalwart lists the agent as
  a member of, and nothing else. A claim is per account, so an agent names the
  groups it holds in its heartbeat and the surface reads one group's agents off
  that.
- **Run now** runs one automation on the newest message of the group's own inbox.
  The ask writes a job, and the agent holding the group runs it on the
  automation's own terms — allowlist and review policy still decide, and the audit
  line says it was asked for. An unarmed automation, one not about mail, a group
  with no message and a group nobody holds are four different sentences, none
  written into the audit.
- **A withdrawn grant is reported and the group stops being served.** The agent
  re-reads its session at most once per poll interval — a minute, a third of a
  lease. An account the session no longer lists is a withdrawal: from that pass
  the group is not served, and the agent writes the loss once into its **own**
  account (group name, account it held, when it noticed), shown on the admin
  surface. Nothing is written or deleted in the withdrawn group; the claim lapses
  with its lease.
- **Three levels of prose, none of which grants anything** (ADR 0019): the
  **installation's rules** (Admin → Master, in the Master's account, carried into
  every call of every group), a **group's standing instruction**, and the
  **automation's own instruction**. Each says how to work; none widens what a run
  may do, because the grant is the automation's capability list, checked on every
  answer. All three sit in the prompt's stable head, so carrying them costs a
  cache hit.
- **The group's standing instruction** is one text per group, written in the admin
  surface (which reaches a group's own files as the installation's agent, so it
  needs the agent's grant, not the administrator's membership) and handed to the
  model on **every** call, after the installation rules and the notebook and
  before the automation instruction and the message. It steers and cannot grant;
  an empty text removes it.
- **A group sets who its runs stop for, once**: one document per group, with two
  choices — **when a person has to agree** (every run, below a confidence, or
  never) and whether a run may **reach outside the group without a person** (off
  until turned on). One policy per group, not per automation. The threshold is a
  behaviour, not a field: "run unattended when confident" is one constant.
  Neither choice can lower a floor in code: an irreversible action always asks,
  and a reach outside the group asks unless the group said otherwise. A group
  with no policy runs on the confident reading.
- **The bootstrap secret** is `GILBERT_AGENT_ADDRESS` / `GILBERT_AGENT_PASSWORD`;
  the session is re-established at every start, so nothing durable is on disk and
  `IMMUTABLE=1` holds. The product neither mints nor rotates a credential.
  Rotating it is the operator's act in Stalwart; a restart carries the new value.
- **Nothing is watched at runtime**: address and password are read once at boot;
  membership is the one thing re-read while running, at most once per poll
  interval.
- **Three admin surfaces (ADR 0003).** **Master** configures the installation
  once: identity, the one model and its bounds, the rules that hold in every
  group, the granted groups. **Group Agents** is the agent in one group, behind a
  picker; its header names the agent serving the group and how much is armed, and
  its four sections are **Behaviour** (standing instruction and review policy),
  **Automations** (one rule per trigger), **Memory** (the notebook) and
  **Activity** (audit trail and agents serving the group), beside a control that
  ensures the reserved label catalogue. Up to four automations — email, file,
  chat, schedule — each with its own instruction and allowlist, pinned by
  `ruleId`/`ruleVersion` on the jobs and audit that reference it, each readable
  by group members. **Approvals** is cross-group oversight of what is waiting and
  what the fleet has done, read-only by construction; an operator answers a paused
  run in the group's own chat. Master also says whether it may read a group's
  roster (`sysAccountGet`, `sysAccountQuery`), which decides whether the chat's
  `@` offers a group's members or the people who have already written (ADR 0005).
- **An automation document this build cannot read is replaced automatically.** A
  group whose `agent/rules.json` is valid JSON but not this build's shape is not
  shown as a group with no automation and does not take its surface down: the
  administration's read (and `/admin/groups/:name/agent/rules`) replaces it with a
  fresh empty one, conditionally on the state just read, and says so once. The
  member door reports and never writes. The executor still refuses to run a
  document it cannot read and records the refusal.
- **An automation is three choices and a paragraph**: **when** it reacts (one of
  four triggers), **what it does** (prose, which carries the branching between
  cases), and **what it may do** (three areas — mail, chat, files and documents —
  plus sending). It is named by its trigger, carries no filter, and a scheduled
  one takes a preset cadence. **Sending** is its own entry because every area
  excludes anything the catalogue marks external or irreversible, computed from
  those flags, so ticking "mail" can never grant sending. **Doing nothing** is
  granted to every automation. The document is validated against a published JSON
  Schema (ADR 0003), the same validator and schema on both sides. No new rule
  language, no hand-typed JSON; Sieve keeps the delivery-time boundary.
- **One enabled automation per trigger.** The executor runs every enabled
  automation on a trigger against every item it produces; two on one trigger is
  refused by the server, prevented by the form (it offers only unheld triggers),
  and reported once by the executor if a document carries one anyway. A disabled
  automation is a draft and may sit beside the enabled one.
- **A time-triggered rule is armed on a cadence**: its next run is stored as a UTC
  instant in the group's scheduler document, so a restart, deploy or crash costs
  the wait and not the schedule, and a replacement agent re-plans from Stalwart.
  Each agent fires the entries of the accounts it holds; vanished runs (rule off,
  rule gone) are recorded as missed.
- **One shape, and the model decides.** Every run hands the instruction to the
  installation's model, which answers with actions from the capability catalogue;
  an answer naming an action the automation was not granted is refused. One model
  is configured once (provider, model, base URL, write-only key) and serves every
  automation. Installation bounds: the ceiling on one answer is a constant, while
  `agent.chainHops` and `agent.pages` are the document's; both are held to fifty
  whatever the document or environment asks, and the panel shows the number a run
  obeys. A file larger than the byte ceiling is not read; one split writes at most
  a hundred pages; an oversized page is rendered smaller, noted in the run. A
  deployment whose model cannot read an image says so (`agent.vision` false) and
  no page is rendered for it.
- **A group has a memory.** The agent carries a **notebook**: facts no automation
  should repeat — how mail is filed, what clients are called, the working
  language, written exceptions. It is a document in the group's own account,
  shown as a list an administrator can add to, correct and remove one fact at a
  time, and it sits in the prompt's stable head. A run writes it too:
  **`notebook.write`** adds a fact, corrects one by id, or removes one by writing
  it with no text, gated and fenced like `file.write`. It steers and never widens.
- **A run can look the group's state up (ADR 0020).** The deciding call may answer
  with a lookup instead of actions, read in the group's own account before
  deciding. The catalogue is the whole group: its **mail** and **chat** by the
  client's own search grammar (`is:starred`, `is:unread`, `from:`, `in:`,
  `label:`, `has:attachment`, dates, sizes, quoted words), one **message** by a
  listed id, its **folders**, its **labels**, its visible **Files** (one level, or
  the whole tree under a folder, filtered by name) and one **file** by a path. The
  grammar is one definition in `server/src/shared/search.ts`, read by client and
  agent alike. Listings hand over names, ids and headers; reads hand over one
  item's text, each capped. The system message is byte-identical on every call;
  the lookups a run made ride its job and audit line.
- **Ask the model to read it** sends the draft and what it is about, the
  installation rules, the group's instruction and its notebook to the model, which
  answers in words about the gaps. It is not a run — no compilation, nothing
  stored, no job, no claim; a call with a timeout, thinking off — and its tokens
  are counted in the **Master's account** as authoring. Refusals travel as codes
  and the answer is model prose. Its monthly spend is
  `agent.authoringMaxPerMonth`, counted from the authoring document and refused
  before the call; two simultaneous readings can both pass it, and a reading the
  month could not record says so.
- **Documents, read by the model that has eyes.** A run can split a PDF into
  pages, merge them, extract one, and *read* a PDF text layer, a `.docx`, a
  workbook (`.xls`, `.xlsx`, sheet by sheet — one sheet is one page), a text file
  (`.csv`, `.txt` and the other plain-text types, read as they stand: no delimiter
  parsed, no column named), or an image (`.png`, `.jpg`/`.jpeg`, `.gif`, `.webp`).
  Text or workbook longer than 200 000 characters is handed over as its beginning,
  told so. A page with no text layer is **rasterised** by a WASM PDF engine (no
  canvas, no native build, no child process) and rides the call as volatile
  content in the tail; an image rides the same way as its own bytes, sniffed
  against the formats' magic numbers. A vision request carries images, not
  documents. `agent.pages` (eight by default) bounds how many pages one run hands
  over, and a longer document is read as its first pages, told so. No OCR engine
  and no `.docx` writer. Everything happens in memory.
- **What the work costs, in counts.** Every run records tokens read from cache,
  read fresh, written, and whether it paid for the model's chain of thought. A run
  whose provider reported nothing is **uncounted**, never zero. A group view shows
  that group's use; a fleet view shows the installation total split per agent. The
  counts are tokens, never money, and a total is a floor whenever a group's audit
  could not be read, which the surface says.
- **One automation's work can wake another, and a chain is bounded.** A file
  written into the group's Files wakes a file rule; a decision answered in chat
  closes the run waiting on it. Every run records the job that woke it; a chain
  runs **five hops** (`agent.chainHops`) and the sixth is **refused loudly**: no
  job, an audit entry with outcome `refused`, and a chat line naming the
  automation and the bound.
- **Labels, not folders.** `G-needattention`, `G-processed`, `G-awaiting`,
  `G-rejected` mark processing state on the individual message; the catalogue is
  created from the Group Agents workspace once the grant exists, idempotently.
  State is per message: a reply arriving in a processed thread starts unlabelled,
  is shown on that message, never aggregated onto a thread or list row and never
  offered in the manual label picker. Moving a message is a separate,
  content-driven action.
- **What it saves, a person can find.** Extracted attachments go into the group's
  own Files — the folder the automation named, else the one the model chose, else
  `Needs attention` rather than loose in the root. A name already taken is that
  person's file: the run writes `2-note.txt` beside it and reports the name.
  Gilbert's own documents (automations, jobs, decisions, audit) stay in the hidden
  `gilbert` folder, which the Files view does not look into; a path naming it is
  refused as a destination.
- **A run is bounded by what it was granted.** An agent that loses its unit
  mid-run stops before anything leaves the process; an approval is consumed
  exactly once; a run executes the version of its automation it was created from,
  and one whose version is no longer current is recorded as a failure rather than
  run. The audit records what a run was about to do before it does it.
- **Approvals happen in the group's chat.** A run the policy stops for pauses,
  writes a decision, prepares the draft in the group's own Drafts (kept unread)
  and posts the proposal in the chat. Any member may answer in words. A send
  reaches outside the group, so it always needs explicit consent, whatever the
  policy says.
- **The agent is its own process.** Same image and codebase, second entrypoint
  (`node server/dist/agent/agent.js`), never a replica of the web tier. It holds
  the Master's event stream, wakes on it and reconciles from the last state it
  recorded; polling is the fallback. Work claims live in the documents, so no
  coordinator exists: one process per account, several accounts per agent, and a
  crashed agent's claims are re-taken by whoever runs, with the work it left
  mid-run. A run nobody comes back for is recorded as a timeout. It answers a
  health probe when `agent.healthPort` is named, reporting the accounts it holds.
  **The server starts one beside itself** when the deployment names an agent
  (ADR 0003); `agent.inProcess` false keeps the fleet in its own process.
- **Members see, never change.** An indicator beside the group's chat opens the
  group's agent surface: which agent works for the group, what instructions it
  carries, what it has done. Everything read lives in the group's own account, so
  a member added later sees all of it; nothing is editable.
- **Every member reads what the agent is told and does.** The panel reads the
  group's own documents through the member's own session: the standing instruction
  as text (who last wrote it, when) and each automation as a short block — name,
  trigger, how it is reviewed, on or off, its instruction in words. A group with
  no instruction says so; one sentence states that only an administrator changes
  either. Members read automations without the allowlist and the authorship
  stamps; nothing on that path writes.
- **The agent says hello once**: "Hi all! Gilbert here, at your service." posted
  when an agent takes the group's claim, itself proof an agent works in the group.
- **Where the documents live.** Rules, jobs, decisions, claims, the schedule and
  the audit trail are documents in the group's own `gilbert` app folder. The
  agent's own account holds its configuration, the provider keys and the
  heartbeats, each naming the groups its agent holds. No database, no volume.
- **Failures are loud.** An unreachable provider, a refused key or a malformed
  answer is recorded in the audit, the message lands in `G-needattention`, and the
  chat is told which automation could not finish. The audit is one document per
  month per group, kept twelve months and pruned a month at a time, in the group's
  hidden `gilbert` folder. A member reads them through the agent panel; an
  administrator reads the same trail in the group's Activity section (or merged in
  Approvals' Audit tab) and can export every retained month as JSON.
- **A refusal reads in the reader's language.** The admin surface answers a
  refusal as a code and its parameters, and the client composes the sentence from
  the loaded catalogue; a language whose catalogue lacks it reads the English. An
  unknown code is read as the prose the answer carried. Text quoted from the
  server that refused travels beside the code as a diagnostic.
- **Not in this layer**: agents for individual users (group agents only), external
  agent fleets (a future decision; A2A stays the recorded candidate), and mail
  notifications — the group's chat is the one channel.

---

# Administration

Product administration inside Gilbert, for users who are **Stalwart admins** —
Gilbert's own, beyond the upstream client (ADR 0001). See
[docs/adr/0001-the-administration-surface.md](docs/adr/0001-the-administration-surface.md).

- **The grant**: Gilbert admin equals Stalwart admin. At sign-in the server reads
  `/api/account` and looks for the configured admin marker (`sysAccountCreate` by
  default, env `GILBERT_ADMIN_PERMISSION`); every privileged call re-checks it
  freshly, so a demotion lands on the next call of an open session. `isAdmin` is
  computed server-side (`server/src/upstream.ts` + `/api/account`) and shown as
  the shield in the top bar. There is no `gilbert-admin` group and no Gilbert-side
  capability registry. Admin without Stalwart's `Impersonate` permission
  administers the install but cannot act on another user; the per-user writes fail
  closed.
- **Administration is a door, not a menu (ADR 0017).** `/api/jmap` refuses any
  body naming a registry object beyond the account's own — an allowlist of the
  self-service objects — with the refused method named; ordinary mail, calendars,
  contacts and files are not inspected, and a session that may administer streams
  through untouched. **The allowlist authorises reads only**: every `x:` `set` is
  refused, and the client sends none (password, app-password and 2FA changes go
  through `/api/account`, which asks for the account's password first). Every
  `/api/admin` route enforces the same conditions beside the marker.
  Administration can be switched off entirely (`server.administration` in the
  installation document, `ADMINISTRATION` for a process with no boot), and can
  separately require the session to have been signed in on a device marked as its
  owner's (`server.administrationNeedsOwnDevice`, off by default). The session
  tells the client which applies, so the menu says why an entry is missing.
- **An account is not acted on by one it outranks.** Forcing a password change
  compares the two permission lists the server resolved and refuses an account
  carrying a permission the administrator does not (`target_outranks`).
- **Installation-wide policy editor.** The shield opens the administration
  surface; its Policy section edits one JSON document with upstream's `defaults`
  / `enforced` / `changes` shape (issue #207) and publishes it. Publishing
  validates, then writes the document into every individual account's own
  Stalwart storage by impersonation — the publishing administrator included — so
  it survives a redeploy and needs no volume under `IMMUTABLE=1` (ADR 0001). It
  applies at once and signs other signed-in clients out so their next sign-in
  reads it (`GET`/`POST /api/admin/policy`, `GET /api/account/policy`). **Each
  publish is a job with an id (ADR 0010)**: one id is minted before the first
  copy, every copy carries `published: { id, at }`, and the job is one document —
  `gilbert/publish-job.json` in the publishing administrator's app folder —
  holding when it started, who published, the population the directory reported
  (how many accounts, whether that was the whole directory, the total when
  stated), the accounts reached, each account not reached with a code
  (`impersonation-refused`, `no-files-account`, `write-failed`, `policy-moved`,
  `directory-denied`), and whether the installation can be said to carry the
  policy. Every per-account write is conditional on that account's file state, so
  a copy that would replace one just written is refused (`policy-moved`); a
  publish whose record could not be stored says `record: "failed"`; the editor
  reads the job back out of the account.
- **Installation document editor.** The Installation section shows the
  installation's own configuration — one JSON document, `installation.json` in
  **the Master's own account's** `gilbert` app folder, which a boot reads whole
  after signing in as the Master — and publishes it. Both halves act on the
  Master's account by impersonation; a deployment that names no Master
  (`GILBERT_AGENT_ADDRESS` unset) is refused with its own code (ADR 0011). The
  read answers the text as the account holds it, including a document this build
  cannot read, and whether one exists; publishing validates with the boot's
  validator and refuses anything that is not a document, with the reason, before a
  byte is written, and refuses a document with no app secret because a boot cannot
  invent one. A publish writes through the boot's writer, conditionally, from the
  **stored** document's epoch, so an editor opened before another publish cannot
  move the epoch backwards and a document that moved mid-publish is refused with
  its own code. The answer says when it applies: the running process keeps what it
  booted with and the next boot reads what was written. `STALWART_URL` and the
  Master's credential are not in the document (`GET`/`POST
  /api/admin/installation`; `server/src/installationAdmin.ts`,
  `server/src/shared/installation.ts`).
- **Forced password change** (ADR 0001): the directive is a file in the target
  user's hidden `gilbert` app folder; the server door answers 403 on every data
  route until the password changes, and the change clears the directive. The
  privileged write authenticates as Stalwart's composite `{target}%{admin}`
  (impersonation) — it needs Stalwart's `Impersonate` permission and a password
  session (app passwords are refused for impersonation), stated up front.
- **Group label catalog**: an administrator defines the label catalog of a group
  mailbox (ADR 0005). The catalog is **the group's** and lives in the group's own
  `gilbert` app folder. The write is made **as the installation's agent**, the
  principal that reaches a group's own files (the deployment's credential where
  there is one, impersonation otherwise), so the requirement is the agent's grant
  on the group, not the administrator's membership. Stalwart 0.16 refuses to mint
  a session for an impersonated group account (live-verified 2026-09-09), so the
  door is never the group's own mailbox.
- **What counts as a group** (ADR 0005): an account that answers as a **mail
  store**. The session's list is only candidates — Stalwart advertises the same
  capabilities on every account it lists — and the one classifier is a probe of
  the account's mailbox tree, server-side and in the client alike. A share is
  never administered or served as a group.
- **Identities** (ADR 0007), under *Gilbert Mailer* after *Force passwords*: one
  section, two tabs — **User identities** and **Group identities**. Each picks a
  principal from a menu of the accounts the server reports (the empty choice is a
  real entry; a deployment that does not enumerate them falls back to a typed
  address), with **Reload identities** re-reading that principal's list and the
  directory.
- **User identities**: an administrator sets a person's display name, address,
  Reply-To, Bcc and signature through the **same form** the person's settings use.
  The write is an **impersonation** of that person — no new credential, nothing in
  Stalwart's configuration. The whole list is shown and editable (add, change,
  remove, respecting the server's `mayDelete`). A **lock** can be applied instead,
  recorded in `identity-lock.json` in that account's own app folder (ADR 0001):
  the person's Identities & signatures section is then not offered. The lock is
  about **personal mailboxes only**; in a group the administration assigns an
  identity and the member reads it either way. **Enforce** and **Release** write
  it with no sign-in in between; the button reads **Enforced** while it holds, and
  sessions re-read the record. The lock is a rule about **this product's
  surface**: Stalwart has no per-field permission on an identity.
- **The default sending identity** (ADR 0007), on the User identities tab: shows
  which identity an account sends from by default and sets it. It is one key of
  that account's own settings document, so the administration and the person's own
  section read and write **one** stored value; clearing the choice is a real state
  and the account then sends with its first identity.
- **Group identities** (ADR 0007): a group mailbox holds **one identity per
  member** — the group's own address, carrying each member's display name and
  signature. The administration **assigns** a member their identity; the fact
  lives in the group's own app folder next to the identity, and it is an
  assignment rather than a compared name, which breaks on a rename, a spelling or
  a name nobody set. A member's row says what they send as, or that nothing is
  assigned and offers to assign one; it reads that member's display name on demand,
  one impersonation when the row is opened. Unassigned identities are listed
  beneath the roster, **the group's own among them** — that one is what an
  unassigned member sends as, the same identity the group's agent sends as. The
  write is always **as the Master** (Stalwart refuses to impersonate a group
  mailbox). Where the Master is not granted, the surface names the missing grant;
  where the roster cannot be read, identities are listed alone and the surface
  says no assignment can be made until it reads again.
- **One list, two surfaces** (ADR 0007): the identities a person may send as live
  in the account that **sends for them** — the one their session names for
  submission — and Settings → Identities & signatures reads and writes **that**
  account, whether the mailbox on screen is their own or a group's. That section
  reads the list when it opens and is refreshed by an administration write, so an
  identity removed in either place stops being shown and offered by the composer
  with no reload. The same account answers every "which addresses are mine?"
  question — trusted image domains, the *me* in a recipient summary, the guests
  made into an event. Beneath their own identities it lists read-only one block
  per group mailbox they belong to, marking **which identity is theirs** or saying
  their mail goes out as the group itself.
- **What an identity reaches**: mail **composed in Gilbert** — the composer and
  the group's agent go through one signature function. Mail written elsewhere
  carries that client's own body and signature; there is no server-side footer
  (ADR 0007).
- **An identity's Bcc** (ADR 0007): addresses every message sent from the identity
  is copied to (a filing address, a ticket system, a compliance archive), written
  into the **Bcc field of the draft** when it opens, so it is visible and
  removable for one message; nothing adds it back at send time. Applied to new
  messages, replies, reply-alls, sent-agains and shares, and **not** to a draft
  reopened from Drafts. Switching identity swaps the address only while the field
  still holds what the previous identity put there. RFC 8621 leaves `Identity.bcc`
  to the client. It reaches only mail composed in Gilbert. On an **enforced**
  account it is an address the person cannot take off, which the Enforce controls
  say.
- **System Sieve** (ADR 0008), under *Stalwart*: an editor for Stalwart's own
  **trusted, server-wide** Sieve scripts — the `x:SieveSystemScript` JMAP registry
  object, not an account's own filters. The write runs as the signed-in
  administrator's own session (no impersonation, since the object belongs to no
  account), gated by `requireAdmin` and, on Stalwart's side, permissions separate
  from Gilbert's admin marker. Stalwart compiles the script on save and a bad one
  comes back as a refusal. More than one system script can be active at once —
  each invoked by name from Stalwart's pipeline configuration, which this surface
  does not manage — and two active scripts cannot share a case-insensitive name.
  The source is edited in **`SieveEditor`**, the CodeMirror 6
  (`@codemirror/legacy-modes`' `mode/sieve` grammar) widget shared with the
  personal "Scripts (advanced)" tab.
- **A save button offers only a change it would make**: every administration save
  is dimmed until there is something to apply, measured against what the surface
  last read back; a creating form asks whether there is enough to create.
- **Nav grouping**: Gilbert Mailer (policy, the installation document, forced
  passwords, group label catalogs, Identities), Gilbert Assistant (the agent fleet
  and what it does per group), Stalwart (System Sieve), and About ungrouped at the
  tail.
- **Where the documents live**: policy and settings documents sit in each
  account's hidden `gilbert` app folder; the per-user policy layer (values and
  enforced flags per user, named profiles, publishing per user or per group) is
  the next layer on the same document shape (ADR 0001).

---

# Chat

A text conversation per group mailbox — the teams you belong to — owned by and
stored in the group's own account, like its calendars and files (ADR 0005).
Offered from a **launcher in the top bar**, first of the action cluster, only when
the session holds group mailboxes.

- **Messages are plain text** — up to 4000 characters — in immutable JSON
  documents inside the group account's hidden `gilbert/chat` folder: one node per
  message, no attachments, no blob URLs, no HTML.
- **Quote replies**: a message can be answered with a quoted snippet above the
  reply; the composer shows the message being answered, and the reply stores the
  original's id.
- **Mentions**: typing `@` names a member and the message records the addresses it
  named. The list offered is the **group's roster** — read for the installation as
  the Master, asked once per conversation on `/api/agent/group/:name/members` and
  held for a minute — so every member is offered whether or not they have written,
  and somebody who has left is not. With no roster, the participants of the loaded
  transcript stand in. A mention of somebody the roster no longer lists renders
  **greyed**.
- **Read markers** — `gilbert/chat-state/read-<member>.json`, one per member,
  written by that member's own session — make **unread = newer than my marker**. A
  member who never opened the chat sees badge 0 and the full transcript; the marker
  is born at first open. A member added later reads from the start, and leaving the
  group removes access with the membership.
- **Live**: FileNode state changes ride the same push rail as mail; a StateChange
  for a group account runs `FileNode/changes` and fetches the new documents; when
  push is down it falls back to the poll.
- **The whole history is reachable**: the thread opens at the newest messages and
  pages older ones in as you scroll up; nothing is silently trimmed.
- **Search the selected group's messages** in the panel header, scanning the whole
  history and listing matches newest-window first; a result jumps to the message.
- **The panel** is a popover under the launcher on desktop (360–400 px; mine right,
  others left, quote replies on hover) and a sheet in the content area on mobile —
  between the top bar and the tab bar — not a sixth tab. It closes when a composer
  opens, and its z-order sits below the composer dock.
- **V1 boundaries** (ADR 0005): no attachments, no typing indicator, no presence,
  no deletion or moderation — growth is append-only; a group that wants to retire
  a chat clears the folders through Files.

## Global contacts

**A directory everyone reads** (ADR 0023): one address book, owned by the Master,
created by the installation at boot, **served to every account through a server
route** (`/api/global-contacts`) and written only by an administrator, from inside
Contacts. A `shareWith` naming every account cannot work — Stalwart caps a share at
10 principals per item (live-probed, 2026-10-02) — so the route is the door, and an
account created later needs nothing added. Every reader sees it as the first row of
the Contacts sidebar and merged in `All contacts`.

---

# The knowledge base

A knowledge base lives inside Gilbert, in the account it belongs to: the company's
policies and procedures and the checklist templates a job of work starts from. It
is the **fifth** module, **KB**, beside Mail, Calendar, Contacts and Files — its
own surface, not a folder of Files — and it is for people and agents alike. Every
page is kept in the mail store (ADR 0024).

## Two knowledge bases

- **The company's** — owned by the installation and read by every signed-in
  account; leads the sidebar.
- **A group's** — owned by the group and read by its members; membership is the
  grant, and a member added later finds it already there.

Both are the same surface and the same kind of page; only the owning account
differs. The sidebar carries the company KB first, then one section per group the
reader is in.

## Pages, folders and the tree

A page is the unit: a title, a body of formatted text and checklists, and tags
that cut across the tree. A **topic folder** groups pages by subject and may nest,
and the whole tree is draggable — drag to reorder, drop a page into a folder.
Search looks across the pages' text. A reference to a page points at the page's
**id**, so renaming or moving a page breaks nothing.

## One shared draft, an administrator's approval

A page holds one **draft** at a time, and everyone who can read it edits that same
draft — people and agents together; there are no competing drafts to merge.

- **Only an administrator creates, renames, moves, reorders and deletes pages and
  folders.** The shape of the tree is the installation's.
- **Only an administrator approves.** Approving turns the draft into a numbered
  **revision** and states the instant it takes effect, shown in each reader's own
  timezone. An instant already passed puts it in force at once; a future one leaves
  it **pending**, with the revision before it still in force until then. A page
  never approved is not yet in force.
- **Nothing issued is edited in place.** The revision a new approval replaces stays
  readable as **superseded**, and the page's **History** holds every revision.
  Restoring an older one opens a new draft, approved again.
- **A page that was ever approved is retired, never deleted.** Retiring takes it
  out of the tree and keeps it, with its revisions; **Retired** brings those pages
  back into view. A page no approval ever touched is deleted outright.
- Every revision has its own **number**, shown read-only beside the title.

## Checklist templates

A page whose body holds checklist steps is a **checklist template**: the steps a
job of that kind must take. The tree marks it with a red checklist icon, and it is
made with **New checklist template**, which seeds the first step. The **Templates**
filter narrows the tree to the templates and the folders that lead to them, and the
page itself lists the **workorders that use it**. The steps are the template: a
workorder that starts from it keeps only the checked state and the signature, so a
template can be approved and versioned without disturbing a running workorder.

## For the agents

The installation's agents read the company KB and the groups' ones, and write
**drafts**: a page they propose to change, a consistency review across pages, or a
multi-page plan that names the revision each page was read from, so a page changed
since the plan was made is refused rather than overwritten. Approval stays with an
administrator; an agent never approves.

## What the KB is not

- **Not a folder in Files**, and its pages do not appear there.
- **No attachments** — a page is formatted text, so approving one fixes everything
  it holds.
- **No per-page restrictions**: every member reads the whole company KB. Where a
  real access boundary is wanted, the design says so rather than pretending.
- **No anonymous access**: reached by signed-in accounts only.

---

# Workorders

A **workorder** gathers, by reference, the folders, files and KB pages a job of
work belongs to, and carries a checklist. It opens from a **factory icon** in the
top bar beside chat, into a large panel: the list of workorders and the open one
stay in the panel while the rest of the app is used beside it (ADR 0028).

## One workorder, a root and its parts

A workorder is one **uid**. Its **root** — identity, friendly name, global
checklist and state — sits in the installation's registry; each group competent
for it keeps a **part** in that group's own account, holding the group's checklist
and references. Opening one shows the global checklist and the reader's groups'
parts together. The same uid names both, and renaming breaks no reference.

## The panel

The list is on the left, filtered by **All**, **Running**, **Completed**,
**Cancelled** and **Replaced**, and the open workorder is on the right: its
checklists and the folders, files and pages it gathers. A refresh re-reads it.

## Checklists, and who checked what

A workorder's checklist is an **instance of a KB checklist template**, bound to the
revision in force when it is created. The template's steps are the controlled text;
the workorder keeps the checked state and names the template. Every workorder has
its own **global** checklist and each group one beside it. A checked step shows
**who checked it and when** — the last signature, from the signed-in account. A
group's members check their group's steps; an administrator, or the agent, checks
the global one. A template with no revision in force cannot be started from; a
retired template still resolves by id.

## References, not copies

Everything gathered is a reference — a folder, a file or a KB page — never a copy
and never a marker planted in a folder. A folder can belong to several workorders;
renaming or moving a target breaks nothing, because the reference is by id. A
target gone or out of reach resolves as **not available**.

## States, and closing

A workorder is **running** until it is closed: **completed**, **cancelled**, or
**replaced** by another workorder, named on it. Closing keeps it for ever and
**freezes the checklist**, so a check after the fact is refused.

## Who can do what

An administrator creates a workorder, closes it and edits its references; an agent
can be asked for one in a group's chat. Every member checks their own groups'
steps. A member sees the global checklist and their own groups' parts, an
administrator sees every part, and an unreachable part is simply not there.

## What a workorder is not

- **Not mail**: an email is not referenced and no mailbox is part of one.
- **Not a folder tree**: membership and references decide what is in a workorder.

---

# The upstream client

The mail client, calendar, contacts, files, sharing and Sieve editing are
upstream's block (**gilbertmailer**), present in this build under Gilbert's naming;
[README.md](README.md) states the lineage, [ADR 0002](docs/adr/0002-upstream-contribution-model.md)
the boundary, and [NOTICE](NOTICE) the attribution. The reference for installing,
configuring or driving them is upstream's own documentation, whose address is in
[NOTICE](NOTICE). The sections below keep this inventory complete; they are not the
part to read to understand what Gilbert is.

# Mail

## Layout

Three panes: folder tree, message list, reading pane. Both dividers are dragged to
resize, and both sizes are remembered per device — they are among the few settings
that do not follow the account. The sidebar's edge takes a double-click back to the
stylesheet's width.

- **It reopens where you were.** The mail account on screen, the address book and
  the folder open in Files are remembered per reader, on this device, each checked
  against what still exists.
- **The reader's own folder tree opens collapsed; a group's opens its folders.** A
  folder opened or closed is remembered as exactly that, per reader, by folder id
  and account.
- **Reading pane** right of the list, below it, or off (messages open full width).
- **Density** comfortable, cozy or compact (row height and padding). **Font size**
  small, medium or large.
- **Sidebar** collapsible to icons; a drawer on mobile; dragged by its edge on
  desktop, hidden while collapsed and on a phone.
- **Mobile layout** with a bottom tab bar, full-screen composer and full-screen
  reading. Full-screen surfaces measure in `dvh` (a phone's `100vh` ignores the
  address bar); the tab bar, drawer, dialogs and compose button keep clear of the
  notch and home indicator (`viewport-fit=cover`). The tab bar is the phone's
  module switcher, so the drawer holds the tree for the section in view and no
  second copy; the top bar carries no signed-in address, so the search field keeps
  its width.

### On a touchscreen

Five gestures, decided by `(pointer: coarse)` rather than screen width, so a tablet
in landscape swipes while a phone with a mouse drags; a mouse keeps drag-and-drop
onto folders.

- **Swipe a row** sideways: right archives and left deletes by default. Either
  direction is a setting — archive, delete, report spam, read/unread, star, move
  to…, or nothing. The strip behind the row names what will happen *in that folder*
  ("Delete forever" out of Deleted Items, "Not spam" in Junk Mail), and a
  meaningless action stops the row moving that way.
- **Hold a row** to select it (plain taps then toggle). **Hold a folder** in the
  drawer for its ⋮ menu. **Pull the message list** down to refresh. **Drag in from
  the left edge** of a conversation to go back.
- **Swipe the calendar sideways** in day or month view to step to the next period
  or back; week and agenda do nothing, and a drag beginning on an event is left
  alone. It asks for a longer drag than a row swipe because it shows nothing on the
  way and offers nothing after.

The toolbar's refresh button and the thread's back arrow both stay. Each threshold
crossing taps the vibration motor where there is one; iOS supports none of that.
The arithmetic lives in `web/src/lib/touch.ts`.

## The message list

- **Virtualised** with `@tanstack/react-virtual`: a folder of 100,000 messages
  scrolls at the same speed as one of ten. Row height follows density and the one-
  or two-line layout.
- **Infinite scroll** with server-side paging, 50 at a time by default.
- **Conversation view** groups a thread into one row with its message count; it can
  be switched off to list messages individually — then a row is one message,
  opening one highlights that message alone and its id rides in the URL (`?m=`).
- **Message order** is a setting: newest or oldest first, unread first, starred
  first, largest first, by sender or subject, or up to three levels of your own
  (Settings › General). It covers the Inbox alone by default and can be widened to
  every folder. Ordering is done by the **server**, over the whole folder; search
  keeps newest-first; every order ends with newest-first as a tiebreak. **Sorting on
  a keyword is optional in RFC 8621**, and a server that refuses it fails the whole
  query, so the refusal is caught once, the keyword levels dropped and the query
  retried quietly; `MOCK_NO_KEYWORD_SORT=1` reproduces such a server.
- **Every row says where the message is stored**, in any list that is not a folder
  (a label, a starred view, a search). The name is the pickers' own — the interface
  language's for a standard folder, the whole path for a nested one, the last
  segment on the row and the full path on hover.
- **Multi-select** with `x`, shift-click for ranges, `Ctrl/Cmd+A` for all, and a
  long press on a touchscreen.
- **Select the whole folder**, not just the loaded rows: the header checkbox takes
  the loaded page, and a line then offers the rest by name as a separate press. The
  wider selection is a *query* resolved from the server, walked a page at a time,
  **uncollapsed**, and consumed by the action that used it. **Undo is withheld once
  the selection reaches messages that were never loaded.**
- **Drag and drop** onto any folder in the tree.
- **Context menu** on any row: reply, forward, archive, delete, spam, read/unread,
  star, move to…, label…, *Filter messages like this…*, and *Create event…*.
- **Snippets and avatars** are optional; the star is always in the row. **Skeleton
  rows** show while a page loads.

### Actions, and Undo

Archive, delete, spam, star, mark read/unread, move and label all offer **Undo** in
the toast that follows, restoring the previous state.

- **Archive puts a conversation back where it was filed** (ADR 0022): a reply that
  returns a thread to the Inbox is filed back to the folder holding the newest
  filed message; only a never-filed conversation goes to Archive, and a message
  already in that folder is filed away as before. A group's copy of the
  conversation is a separate thread.
- **Archive by date** files into `Archive/<year>` or `Archive/<year>/<month>`,
  creating and reusing folders, named numerically and zero-padded (`2026`,
  `2026/09`) because these are real server-side mailboxes. The date is read in the
  reader's own timezone. A selection spanning two months is two destinations; one
  Undo puts the whole selection back.
- `Delete` moves to the bin. **Empty** destroys and is offered only on Deleted
  Items and Junk Mail — enforced where the action happens. Emptying Junk destroys
  rather than moving to the bin; there is no undo for that one, and the dialog says
  so.

## Folders

Real JMAP mailboxes, with the server's roles honoured. The sidebar's header names
the account whose tree is on screen.

- Create, rename, create a subfolder, delete (with or without its mail).
- **Move a folder** by dragging it onto another or from its menu — *Move to…* opens
  the same searchable picker messages use, with a *Top level* row, listing folders
  in the sidebar's order under their parent. It offers only legal destinations
  (`mayRename` on the folder, `mayCreateChild` on the destination); folders with a
  server role are structural and not offered.
- **Subscribe / unsubscribe** — *Show in list* / *Hide from list*. An unsubscribed
  folder still receives; Inbox cannot be hidden. **In a group mailbox a member's
  folders are subscribed for them** (ADR 0021): the client writes the subscription
  back for every folder that lacks it as it reads the tree; hiding one is not
  offered in a group.
- **A group's tree is drawn whole** (ADR 0021), subscribed or not, because group
  folders arrive unsubscribed. Which tree is whose is asked of the session, so it
  holds from the first frame.
- **Mark all as read**, optionally including subfolders. **Folder colours** per
  mailbox id. **Unread counts** per folder, live.
- **Storage quota** bar under the tree where the server reports one: the account on
  screen, and the server's number for its whole disk usage (mail and files).
- **Settings → Folders is about this account's own folders**; a group's stay in the
  sidebar and are not listed there.
- Rights are respected per folder: rename, delete, create-child and share grey out
  when `myRights` says no.
- **In a group, ending mail is an administrator's decision** (ADR 0015). A group
  mailbox is reached by membership, so the mail server tells one member's delete
  from another's by nothing; the rule is the client's, in one module. Filing,
  archiving, labelling, replying and forwarding all still work, and the three things
  that end a message for good are refused: deleting out of Deleted Items or Junk
  Mail, emptying either, and deleting a folder that holds mail. A refused action
  says so and names what still works. It is a rule the product keeps, not a
  boundary.
- A folder in the URL this account does not have says *this folder is missing*
  rather than drawing an empty folder.

## Labels

Labels are **IMAP keywords** with a colour and a display name kept in settings, so
every other client that reads the mailbox sees them, and they survive Gilbert
entirely. A message can carry any number. They are managed in Settings › Labels,
applied from `l` or the context menu, and optionally listed in the sidebar.

- **The list belongs to the account in the foreground**: the reader's personal
  labels on their own mailbox, and a **group's own catalog** on a group's
  (ADR 0005). The pencil goes only where the client manages labels; a group's
  catalog is read from the group's own app folder.
- **A change made by another member shows up live.** A star or label written in a
  group mailbox reaches other members through the push rail as an `Email` change,
  and counts re-read; a catalog edit is a `FileNode` change.
- **Nesting is display only** — keywords stay flat on the message, so moving a
  label under another rewrites nothing. The parent picker will not offer a label's
  own descendants; a label whose parent was deleted comes back to the top level,
  and a cycle arriving from an older device is broken.
- **How prominent each one is**: always in the sidebar, only while it has unread
  mail, or never. A label kept by that rule **keeps its ancestors**.
- **The sidebar counts it as unread (all), and Starred leads the list.** Each row
  carries *how much of it is new* ahead of its total — `3 (5)` is three unread out
  of five, the unread number bold — and **Starred** sits above them as the first
  row: the keyword a star writes, with no colour or name of its own, drawn with the
  star it is named after. Clicking either opens the messages it counts.
- **The number counts the unit the list will show.** With conversation view on a
  three-message conversation carrying a label is **one**; with it off it is three,
  using the same thread-collapsing the list uses.
- **A star, and a label, belong to whatever the row is.** With conversation view
  on, one row *is* the conversation, so starring or labelling it applies to every
  message of it that this folder holds; with it off a row is a message. Inside an
  open conversation each message keeps its **own** star; the conversation's star is
  the one at the top.
- **The unread half is kept, and the row leads with it** — two queries per keyword
  in one request.
- **The number follows a write**: the row is the unit the count is taken over, so a
  write touching several messages of one conversation moves its number once.
  Reading a message moves only the unread halves. A failed write puts the messages
  back and re-reads the counts.

## Search

The query runs on the **server**, over the whole mailbox. Gmail operators work as
written.

| Operator | Notes |
| --- | --- |
| `from:` `to:` `cc:` | Address or name substring |
| `subject:` `body:` | |
| `has:attachment` | |
| `has:star` `has:flag` `is:starred` `is:flagged` | |
| `is:unread` `is:read` | |
| `in:` `folder:` | By role (`inbox`, `sent`, `spam`, `starred`), then exact name, then substring. `in:anywhere` / `in:all` searches everything |
| `label:` `keyword:` | Repeatable; `-label:` excludes |
| `before:` `older:` `older_than:` | |
| `after:` `since:` `newer:` `newer_than:` | |
| `larger:` `size:` `smaller:` | `500k`, `5m`, `2g`, or bare bytes |

Dates parse as `2025-11-22`, `2025/11/22`, `11/22/2025`, anything `Date` accepts,
or relative (`3d`, `2w`, `6m`, `1y`). Quoted phrases hold together, including
inside an operator. Bare words become full-text terms. With no `in:`, the search is
scoped to the folder being viewed. An **advanced panel** behind the magnifier
offers From, To, Subject, Has the words, folder, date range, has-attachment and
unread-only, and composes the same query string.

## Reading a message

- **Sanitised HTML**, rendered inside a **Shadow DOM** so the sender's CSS cannot
  reach the app. DOMPurify strips scripts, event handlers, forms and anything that
  could navigate the top window.
- **Plain-text mail keeps its shape** — the sender's line breaks kept, a step per
  level of quoting with the quoted block collapsible (`EMAIL_BASE_CSS`,
  `web/src/lib/html.ts`).
- **Mail wider than the pane scrolls sideways**; vertical overflow stays clipped.
- **Remote images follow the image policy**, which ships as *Always show*. The
  policy is ask, automatic for people in your contacts, or always; the per-sender
  allow-list lives in settings and follows the account. When it asks, a banner
  offers *Show images* or *Always from this sender*.
- **Privacy image proxy** (on by default): approved remote images are fetched by
  Gilbert's server, so the sender learns no IP address, no user agent and no read
  time. With the proxy off, images load directly and the sender learns all three.
- **Inline images** (`cid:`) are resolved against the message's own parts.
- **Attachments** listed with type and size: download, open in a new tab, inline
  preview for images and PDFs. **Download all** takes the lot; **Download all to
  Files** keeps them in the account instead — asking whose files, then which folder
  inside them, for the reader's own files or a group's. The blobs are copied into
  the chosen account. Offered for one attachment as much as for a set.
- **Show original**, **Show headers**, **Download (.eml)** and **Print**.
- **`winmail.dat` opens.** Outlook Rich Text packs attachments into one TNEF blob;
  a banner offers to open it and the contents appear as ordinary attachments, with
  the long filename read from the MAPI stream where there is one. It is decoded
  **in the browser, on request** (the server never sees the contents); a partial
  decode keeps the files read so far, and the original stays attached. The message
  body is deliberately not decoded.
- **Forward as attachment** sends the message itself — headers, structure and every
  attachment intact — with **no upload at all**, because a message's `blobId` is
  its own RFC822 blob. Offered in the message's ⋮ menu, the list's right-click menu,
  and the reply strip's overflow.
- Saved and attached `.eml` files are **named from the subject in whatever script
  it is written in**, keeping letters and dropping only what a filesystem cannot
  take (path separators, Windows-reserved names, control characters).
- **Unsubscribe** where the message carries `List-Unsubscribe`. **Sender details**
  expand to the full From/To/Cc/Reply-To with addresses.
- **What the spam filter said** is read back off the message: the verdict, the
  score, the threshold it was measured against, and the rules that moved it,
  largest mover first and signed. Both the SpamAssassin-shaped `X-Spam-*` set and
  Rspamd's `X-Spamd-Result` are read; anything else is left alone. A score is
  always given its threshold, and where no verdict was recorded none is invented.
- **Message body theming** is off by default. One setting lets mail with no colours
  of its own follow the app's theme; a second setting, off unless the first is on,
  forces the theme over the sender's colours, telling a *sheet* from a *painted
  surface* by relative luminance. Nothing the sender wrote is removed, so the
  switch is reversible, and print is unaffected.

### Conversations

- With conversation view on, a conversation opens on its **first unread message**;
  the opening scroll is held until the thread settles.
- `n` / `p` move between messages in the thread; `]` archives and opens the next.
- **Auto-advance** after archive or delete: back to the list (default), onward to
  the next, or previous.
- **Mark as read** immediately, after 2s, after 5s, or never automatically.

### Cards inside a message

- **Invitations (iTIP)** render an invite card: what, when, where, the guest list
  with each status, and Yes / Maybe / No. The reply is written to the event and sent
  back; cancellations are recognised.
- **vCard attachments** render a card offering to add the person.
- **Right-click anyone named** — From, To, Cc, Bcc or Reply-To — to add them to
  contacts (prefilled, display name split), edit them, write to them, or copy the
  address.

### Read receipts (MDN, RFC 8098)

Stalwart does not implement JMAP's `MDN/send`, so Gilbert assembles the
`multipart/report` itself, uploads, imports and submits it, which is why a sent
receipt lands in Sent. Nothing is sent automatically, and there is deliberately
**no "always" setting**.

- Bulk mail, mailing lists and anything marked `Auto-Submitted` are not offered a
  receipt.
- A receipt aimed somewhere other than the sender says so before it is sent.
- Sending is recorded with `$mdnsent`, so a second look or another client knows
  not to ask again.
- The setting offers *ask me each time* or *never*. Requesting one on your own
  outgoing mail is a separate switch.

## Composing

**Multiple composers at once**, floating in a dock at the bottom right, each
minimisable and maximisable; full-screen on mobile.

- **Rich text**: bold, italic, underline, strikethrough, text colour, highlight,
  font size, alignment, bulleted and numbered lists, indent/outdent, blockquote,
  code block, links (`Ctrl+K`), inline images, an emoji picker, and remove
  formatting. Tab and Shift+Tab indent inside a list. The editor is **Squire**
  (ADR 0029): a quoted or forwarded message keeps its original markup, quoting
  nests, and the same component serves the composer, templates and an identity's
  signature.
- **Plain text** as a per-message or default format.
- **Recipient chips** with autocomplete from contacts, shared address books you
  have added, the server directory and recent recipients; your own cards win a tie.
  Free-form addresses parse leniently (`Ann <ann@x>, bob@y; "C, D" <c@z>`). A
  **group** is offered with them, marked with its size, and taking it adds those
  people — one address per member, the preferred one — with a note when a member
  had no address (ADR 0004).
- **Recipient picker** — the contacts button beside Cc/Bcc, or the To label — opens
  the address books to search across every book or one, tick people and send them
  to To, Cc or Bcc. Every address gets its own row; a group gets a row of its own,
  marked with its size.
- **Cc, Bcc and Reply-To** revealed as needed; an identity's own Bcc arrives already
  in the Bcc field, visible and removable.
- **Priority**.
- **Identities**: multiple From addresses, a per-account default that Gilbert keeps
  (JMAP has no such flag), and hiding identities from the picker without deleting
  them. In a **group mailbox** the picker offers the identity the administration
  **assigned** to the reader and the group's own behind it (ADR 0007); the composer
  says so only when the group holds no identity at all.
- **Signatures** in HTML per identity, inserted above or below the quote. Stalwart
  caps an identity signature at 2047 **bytes** of UTF-8, so Gilbert compacts the
  HTML and, where it still will not fit, stores the full signature in the account's
  Files and leaves a marker plus a plain-text fallback in the identity. Signature
  images live in Files and become inline `cid:` parts at send.
- **Templates**: named subject + body, inserted into any draft, managed in
  Settings. Both carry **placeholders** — `{{recipientName}}`,
  `{{recipientFirstName}}`, `{{recipientEmail}}`, `{{myName}}`, `{{myEmail}}`,
  `{{subject}}`, `{{date}}` and `{{time}}` — filled when the template is inserted,
  so what they came to is visible and editable before sending. Dates and times
  follow the app's format settings. An unanswerable placeholder is **left in the
  body exactly as written**; a name that is not a placeholder is left alone.
- **Attachments** by picking or dragging onto the composer, with progress per file
  and the size limit the server states (`MAX_UPLOAD_BYTES`, 50 MB by default). A
  pasted image is inserted inline; pasted HTML is sanitised.
- **Attach from Files** — anything the server already holds attaches with **no
  upload at all**. A file from someone else's shared folder is copied to your
  account first (the picker says so), because a message can only carry blobs from
  the account sending it. Your **groups' files** are listed alongside your own. The
  upload limit applies to that copy only: `maxSizeUpload` bears only on a file
  about to be uploaded, never on a blob already held.
- **Attachment reminder** when the text mentions an attachment and none is there.
  **Spell check** toggle. **Drafts** save as you type and on close, with the save
  state shown.
- **Quoting** on reply, with the signature above or below it. One reply reaches
  **one partner** and Reply all reaches **everyone**; the one-button affordances
  reach everyone, and every menu offers both actions, each saying which it is. `r`
  answers the sender, `a` answers the list.
- **Compose as new** — the same mail again rather than passed on. Recipients,
  Reply-To, subject, body and attachments come across as they stand; the
  Message-ID, date and threading headers do not, and the original is neither
  altered nor marked. Offered in the message menu, the list's right-click menu, and
  the reply strip's overflow.
- **Send and archive**, and **archive on reply**, as options.

### Undo send, and scheduled send

- **Undo send** holds the message in the browser for five seconds and shows a toast
  naming the mail, with a way back. Nothing has been submitted. The window is a
  product constant, not a setting.
- **Scheduled send** hands the message to *Stalwart's* queue. JMAP has no
  client-settable `sendAt`, so the hold is requested through SMTP FUTURERELEASE
  (RFC 4865) as a `HOLDUNTIL` parameter, and the server reports the `sendAt` it
  settled on. It goes out whether or not Gilbert is open. Held messages wait in a
  **Scheduled** folder Gilbert maintains itself (JMAP has no role for one) and
  reconciles when you next open it: released messages move to Sent, cancelled ones
  back to Drafts. The picker offers presets and an exact date and time, bounded by
  the maximum delay the server advertises.
- If Stalwart's `futureRelease` is not configured, a "scheduled" message is sent
  **immediately**, with no error and no sign the hold was dropped. Gilbert only
  offers the feature when the account advertises the capability, and the mock has
  `MOCK_NO_FUTURE_RELEASE=1`, which advertises it and then drops every hold.

---

# Calendar

JMAP Calendars and JSCalendar (RFC 8984), with Stalwart's vocabulary where it
differs from the RFC.

## Views

Month, week, day and agenda, each addressable by URL
(`/calendar/week/2026-08-30`). A mini calendar for jumping, *Today*, and
next/previous by keyboard (`n`/`p`) or button. The default view, week start,
working hours and default event duration are settings.

## Calendars

The sidebar keeps the panes apart:

- **My calendars** — yours, each with a colour, each hideable with a click.
- **Group calendars** — one section per group mailbox: their calendars listed one
  after another, each naming its group on hover, and a **+** that creates a
  calendar **owned by the group** in the group's own account, asking which group
  when there is more than one. A group's calendars need no adding — membership is
  the subscription — and none can be removed: hidden and shown, never
  unsubscribed, for a member and an installation administrator alike. A group
  calendar's **colour belongs to the calendar**, and only an installation
  administrator may change it.
- **Shared with me** — other people's, once added.
- **Available to add** — shared with you but not yet added, with a plus beside
  each. An unadded calendar draws nothing, because the server reports every
  collection in an account you can reach and being handed one is not evidence it
  was offered.

Right-click your own to rename, recolour, share, stop sharing or delete;
right-click a group calendar to hide or show it; right-click one of someone else's
to remove it from your view.

- **iCal import** through `CalendarEvent/parse` (a file of any number of events),
  from the calendar's own menu, into that calendar. The events are filed rather
  than scheduled: no invitations go out.
- **Re-importing updates rather than duplicates**, recognised by UID per calendar,
  and what the file carries wins. **Who accepted** and **edits to a single
  occurrence** are left alone. An attendee added at the source since the last
  import does not arrive, and an import sends no scheduling messages, so an event a
  re-import moves is moved here only.
- **Subscribed calendars** by URL — a timetable, a rota, a public holiday list.
  Added in Settings › Calendar & contacts, read-only, shown beside your own.
  **Nothing is stored**: the document is fetched when you open the calendar and
  parsed in the browser, with no cache and no timer, so a subscription is as
  current as the last time somebody looked. The fetch happens on the server,
  because almost no calendar URLs send CORS headers, and goes through **exactly
  the same guard as the image proxy**: the name is resolved and every answer must
  be acceptable, the connection is pinned to the checked address, and each redirect
  is re-resolved and re-pinned. `webcal:` is understood and read as `https:`. A
  calendar on a private address is refused by design, and **recurring events are
  not expanded** (`RRULE`), so a subscription shows the first occurrence. A
  subscription that cannot be read **says so** rather than drawing an empty
  calendar.
- **Birthdays**, derived from the birthdays already on your contacts. Off until
  switched on in Settings › Calendar & contacts, and hideable from the sidebar.
  **Nothing is written anywhere**: an entry disappears when the contact does or the
  birthday is cleared. They cannot be edited or deleted — the virtual calendar
  reports no write rights and the store refuses a synthesised id. A card recording
  only a day and month gets a birthday with no age; 29 February falls on the 28th
  in a year that has no 29th.

## Events

Created by clicking an empty slot or dragging across a range; a context menu on
empty space offers a timed or all-day event at that moment, or *Go to day* / *Go
to week*. Also from a message (see *Create event…*).

The editor covers title, start and end (all-day or timed, with a time zone),
calendar, location, meeting link, guests, description, reminders, repeat, status
(confirmed / tentative / cancelled), show-as (busy / free), visibility (default /
private / secret), category and colour.

- **Recurrence** — none, daily, weekly, weekdays, monthly, yearly, or a custom
  builder: interval, by-weekday, by-month-day, and an end by count or date.
- **Reminders** — one or more alerts before the start, with a default in settings.
- **Colour categories**, Outlook-style: named colours managed in Settings ›
  Calendar, assigned from the editor or the context menu, and stored as JSCalendar
  `categories` so other clients see them. A per-event colour comes from the
  category, or the calendar.
- **Duplicate** an event from the context menu.
- **Create event…** from a message, in its context menu and its ⋮ menu (and in a
  held row's ⋮ on a phone). The subject becomes the title and the body the
  description; the sender and everyone addressed become guests, minus your own
  addresses and never a blind copy. The editor opens on the next half hour for an
  hour, with *Send invitation emails* off.
- **Popover** on click with the detail and quick actions; the editor on *Edit…*.

## Attendees, invitations and free/busy

Invitations go out as iTIP when guests are added, replies come back and are
applied, and cancelling notifies the guests. Guests are added by name or address
with the composer's autocomplete.

Where the server implements `Principal/getAvailability`, the event editor grows a
**scheduling panel**: a row per participant — you first — over the days the event
spans, marked by the hour or by the day.

- **It is somewhere to put the event, not only something to read.** The pointer
  shows the half hour it is over, and clicking moves the event there keeping its
  length.
- **It steps backwards and forwards** a screenful at a time without touching the
  event, and offers its way back.
- **A week is as far as it stretches**, saying how many days it left out.

**Whoever cannot be read is drawn hatched, never blank**, with a line saying how
many and why: free/busy is answered per principal and only accounts on this server
are principals, so a guest at another domain has nothing to read. A `Principal`
exposes no route to its calendars, so free/busy is the only channel between two
accounts and needs no sharing set up first.

## Recurring events: series and single occurrence

Editing or deleting a recurring event asks which it applies to: the **whole
series**, or **this occurrence only** (a `recurrenceOverrides` entry).

- **Not everything can differ per occurrence.** 0.16.20 sorts properties into
  three groups: some are *rejected* loudly, some are *inherited* (dropped from the
  patch while the response reports success), the rest applied. Gilbert checks the
  patch before sending, so a rejected property is a visible error and an inherited
  one is reported as something it could not do for one date.
- **Occurrence ids**: 0.16.21 identifies an occurrence by its recurrence id, so a
  write does not renumber a series; 0.16.20's synthetic ids encoded a *position* in
  the expanded series. Gilbert re-resolves an occurrence from its `recurrenceId`
  immediately before touching it, because it supports 0.16 as a whole.
- *This and future* is not offered: the server refuses an occurrence belonging to
  such a change, and where it does Gilbert says so and offers the series.
- **Events are dragged.** In the day and week grids an event moves by dragging it
  and changes length by dragging its bottom edge, snapping to fifteen minutes; in
  the month grid it moves to another day keeping its time. A recurring event asks
  which dates it means and goes through the same path. A read-only calendar and a
  birthday offer no drag. **Invitations are not sent** on a drag. The new time is
  worked out **in the event's own frame**, and a month-grid move shifts it by the
  days moved.

---

# Contacts

JMAP Contacts and JSContact.

- **The list is resized by its edge**, with a floor that keeps a name and address
  legible, a ceiling that leaves the contact its own width, and a double-click back
  to default. Its width is remembered per device; the divider is hidden where a
  narrow screen shows one pane.
- **Address books**: **Contacts** leads with **Global contacts**, then **All
  contacts**, then the reader's own under **My contacts**; a **Group contacts**
  section lists the books of every group mailbox you belong to, each naming its
  group on hover, with a **+** that creates a book **owned by the group**, asking
  which group when there is more than one; other people's are under **Shared with
  me**, with the same *Available to add* split the calendar uses. Create, rename,
  share, stop sharing, delete; one is the default for new cards.
- **Contact records**: photo, prefix, first, middle, last, suffix, nickname,
  company, job title, any number of emails, phones and addresses with types,
  birthday, website and notes.
- **Groups** as a card kind, with members picked from the book the card is filed
  in. A group has no email, phone, post, dates or links, and those fields are not
  offered or written. **Every row says which kind it is**: a group's name is
  **bold**, a person's carries the **company** beside it, and an organisation says
  *· organization* because its own name is the company. A card with no person name
  is shown as its company. **Email group** addresses its members through the one
  resolution the composer uses (ADR 0004).
- **All contacts holds every group's contacts as well as your own**, with the group
  named on the row that came from one. A colleague's shared book stays out. A row
  is opened by its account and its id, because ids are minted per account.
- **Select and delete in bulk** — tick rows, shift-click for a run, delete the lot;
  or **Empty address book** from the book's own menu. A card filed in two books is
  removed only from the one being emptied; what is reported afterwards is what the
  server confirmed, and a selection may span accounts.
- **Letter index** down the list, with `#` for anything not starting with a letter.
- **Search** across name, address, organisation and notes, in one book or all.
- **vCard import** through `ContactCard/parse` (a file of any number of cards), and
  **export** of one card, a whole book, or everything as `.vcf`.
- **LDIF import**, for address books from SOGo, Thunderbird or an LDAP directory.
  Nothing on the server reads LDIF, so the file is read here: RFC 2849 for the
  syntax and [Mozilla's address book schema][ldif-schema] for the attributes. Work
  and home addresses, every phone kind, second email, organisation and units, job
  title, nickname, web pages and custom fields come across. The import control
  takes either format and decides by content.
- **Re-importing updates rather than duplicates.** A vCard is recognised by its
  UID, an LDIF entry by its distinguished name. The card already here is merged
  with the file's version — what the file carries wins, what it does not mention is
  left alone. Matching is per address book. An entry no longer recognisable is
  imported again and counted.
- **Directory lookup** through `Principal/query`. **Recent recipients** are kept on
  the device, and only on a device you said was yours.
- Contacts in a shared book you have added — or in any book of a group you belong
  to — are offered when addressing a message exactly like your own; your own card
  wins a tie. A group's books need no per-member adding. Shared cards load by page
  up to **5 000** per account.
- **A group's contacts are the group's to work with.** Edit and Delete are offered
  on a card in a group mailbox's address book to the members of that group, because
  the book grants the write — the client asks the book holding the card, not whose
  account the card is in. The book itself is named by whoever may write it, and the
  write goes to the account that holds it. A colleague's read-only share stays
  read-only.
- **Moving a contact between accounts is an administrator's** (ADR 0018). A card
  lives in one account and a group's card is the group's, so a right-click offers
  **Move to…** to an installation administrator only, naming each group and its
  books. Filing a **new** contact into a group's book, editing one where it lives
  and re-filing a card within one account are not moves and are unchanged. The
  editor's picker follows the same rule. It is a rule this client keeps, not a
  boundary.

[ldif-schema]: https://wiki.mozilla.org/MailNews:Mozilla_LDAP_Address_Book_Schema

---

# Files

JMAP `FileNode`, in the shape 0.16 defines (`nodeType`, four separate rights).

- **Folder tree** in the left pane, fetched **in one request**, so opening a folder
  never waits on a round trip. **Collapsed by default, and remembered per reader**,
  by account and id, because node ids are unique per account.
- Browse, download, create folders, rename, move, delete.
- **Sorted by a clicked column, and each folder keeps its own order.** Clicking
  **Name**, **Size** or **Modified** orders the listing, and clicking the column in
  force turns it around. The sorted column's name is **bold** with an arrow;
  **folders come first whatever the column**, and within each group the column
  decides with the name breaking ties. The order is remembered **per folder** on
  this device; a folder is read whole and sorted in the browser.
- **Multi-select with checkboxes**, with a select-all in the header (indeterminate
  while some are ticked). The bar that counts the selection offers **download its
  files**, **move**, **merge folders** and **delete**, and is **always on screen**
  ("0 items selected").
- **Open a folder by double-clicking it.** A single click selects a row, the name
  included; in the sidebar a single click goes to the folder and a double click
  opens or shuts its branch, with the twisty doing the same.
- **Merge two folders into one** (ADR 0014). Ticking exactly two makes **Merge
  folders…** usable; it asks which of the two **names stays**, and everything the
  other holds moves into it — a subfolder in both is merged, a **file** whose name
  is in both has the other's bytes written into the node that already holds it
  (same id, sharing and place) and the source file is destroyed; the given-up
  folder is destroyed last, once empty. It is **decided before anything is
  written**: a collision (a name that is a folder on one side and a file on the
  other) or a missing right stops it with nothing written. It runs in the tray
  ("2 of 7 items") with **Cancel**, and a stopped merge leaves both folders
  standing.
- **Drag a row** onto a folder in the list or anywhere in the tree to move it; a
  folder cannot be dropped inside itself.
- **Drag from the desktop** to upload — including a *folder* with its structure
  intact, subfolders created as needed, **empty folders included**.
- **Dropping a folder that is already there adds to it** rather than making a
  second one: folders are resolved first and only what is missing is created. A
  **file** whose name the folder already holds is **written over, in place**
  (ADR 0013), so its id, sharing and place in the tree stay and only the content
  changes; dropping the same tree twice is one tree holding the latest bytes. A
  file may not write over a **folder** of its name — nothing is renamed, destroyed
  or put beside it, and the file is reported on top. A folder the drop could not
  create stops with its whole subtree reported.
- **A drop resolves its tree in one request.** The account is read once and the
  whole walk answers from it; an account larger than one read (a thousand nodes) is
  finished by reading the levels it must, not by paging the account. A file's name
  is answered by the create itself.
- **Cancel an upload.** Every upload in flight shows its count ("3 of 12 files")
  beside its percentage, and **Cancel** stops one file or the whole run a drop or
  picker action started. What has already gone up stays and nothing not started is
  sent; the switch arrives with the run's first file.
- **Sharing** per file or folder, with rights per person. **Attach from Files** in
  the composer, with no re-upload.
- **Saved into from mail**: a message's attachments can be kept here instead of
  downloaded, into your own files or a group's, and into **any folder inside it**,
  walked or created in the dialog. Offered for one attachment as much as ten. A
  file the chosen folder already holds is reported rather than replaced
  (ADR 0013).
- One folder is hidden on purpose: **`gilbert`**, contents and all. It holds the
  settings file and signature images, and the Files view drops it from the listing.

---

# Filters (Sieve)

A visual rule builder that round-trips losslessly to a real Sieve script. Rules are
stored inside the script itself as `# rule:{…}` JSON comments, with the generated
Sieve below each one, so the script the server runs is the script you can read and
the builder can reconstruct the rules from it.

**Conditions** — match all or any of:

| Test | Options |
| --- | --- |
| Header | From, To, Cc, Subject, List-Id, Reply-To, X-Spam-Status, or any header you name |
| Address | Any header, matching the whole address, the local part or the domain |
| Size | Over / under |
| Body | Contains / does not contain |

Each header and address test takes: contains, is, matches (wildcards `*` `?`),
regex, exists — and the negation of each.

**Actions**: file into a folder (creating it on the spot, optionally keeping a
copy), redirect to an address, discard, keep, reject with a reason, add / set /
remove a flag, mark read, star, and stop.

- **Enable or disable** a rule without deleting it, and reorder them by dragging or
  with the up/down buttons — order is what Sieve evaluates in.
- **Raw script editor** underneath, with the server validating before save.
  **Preview generated Sieve** for the visual rules.
- **Nothing is discarded without asking.** Both editors keep their edits until
  save, and every way off the page asks first, offering to save. The save bar is
  pinned to the foot of the pane.
- **Refuse to save from a script only partly read** — a save is checked for
  completeness against the shape the generator emits.
- **Filter messages like this…** from a message's context menu, pre-filled from the
  sender or the list.
- **Apply to the messages already in this folder** — evaluated client-side, then
  the server only runs Sieve on delivery.
- **Folder renames are tracked**, so a rule that files into a folder keeps working
  when the folder moves.
- **Out of office** sits beside it as a JMAP `VacationResponse` — subject, body,
  and an optional start and end.

---

# Sharing

Files, calendars and address books share with other accounts on the same server
through JMAP Sharing. Right-click something you own, choose **Share…**, pick people
from the directory, and give each Viewer or Editor — or set individual rights by
hand.

- **Shared things appear where they belong**, not behind an account switcher:
  somebody's folder is in Files, their calendar in the calendar, their address book
  in Contacts, each under *Shared with me*. There is no account switching.
- **Adding is a deliberate step**, because the server reports every collection you
  can reach. Except for **a group you belong to** — its calendars, address books
  and files are the group's own, owned by the group's account and written there at
  creation, so they answer everywhere without anyone adding them.
- **Stopping is separate from hiding** — *Stop sharing* on something you own
  withdraws access from everyone at once, after asking; *Remove from my view* on
  something shared with you changes nothing for anybody else.
- Anything of yours that is shared carries a badge.
- Where the server will not remember that you added a share — 0.16 refuses
  `isSubscribed` on a read-only address book while accepting it on a calendar —
  Gilbert keeps the list in the settings that already follow you between devices.
- **Sharing a mail folder is not offered.** Stalwart accepts it, stores it, and
  never delivers it. A folder shared before that was withdrawn still offers *Stop
  sharing*.

---

# Cross-cutting

Settings, live updates, the platform surface and security run through both parts:
the settings policy and the immutability are Gilbert's own, and the rest is the
client's machinery, described here because a change in either part has to keep the
other true.

# Settings

## They follow the account, not the browser

Preferences live in a `settings.json` in the account's own JMAP Files, beside the
signature images. So identity, signatures, locale, date and time formats, theme,
labels, templates, folder colours, trusted image senders and added shares are the
same wherever you sign in, private windows included, and are backed up with the
mail store because they *are* in the mail store.

- Settings that describe *this screen* stay local: density, font size, sidebar
  state, the two pane sizes, and the notification toggles, which track a per-device
  browser permission. The list is written as the exceptions, so a setting added
  later syncs by default.
- The swipe actions are a deliberate non-exception: someone who decided that a left
  swipe deletes decided it for their phone and tablet both.
- Two limits: conflicts are last-write-wins, and a change made on one device does
  not reach another that already has Gilbert open until it signs in again.

## Sections

| Section | Holds |
| --- | --- |
| **General** | Reading pane, mark-as-read delay, auto-advance, conversation view, snippets, avatars; compose format, quoting, signature placement, spell check; time zone, week start, language & region, date format, time format; `mailto:` handler; export / import / reset |
| **Privacy & safety** | Remote images and the senders trusted with them, read receipts asked for and answered; the three warnings and the domains they measure against; undo-send window, attachment reminder, confirm-before-delete |
| **Appearance** | Theme, accent colour, density, font size, sidebar, swipe actions, interface language |
| **Identities & signatures** | Addresses, names, Reply-To, a Bcc copied on everything sent from the identity, HTML signatures, the default, which to hide from the picker, and — read-only — the group identities the administration sets |
| **Filters & rules** | The visual builder and raw Sieve editor |
| **Out of office** | Vacation response |
| **Folders** | Create, rename, colour, subscribe |
| **Labels** | Keyword, display name, colour |
| **Templates** | Named subject + body |
| **Calendar & contacts** | Colour categories, working hours, default view, default duration, default reminder |
| **Notifications** | In-tab notifications, notify-when-closed (Web Push), sound |
| **Security & sessions** | Password, two-factor state, app passwords, active webmail sessions |
| **Keyboard shortcuts** | The full list, grouped |
| **About** | Version, source URL, server, and the capabilities it advertises |

**Privacy & safety is separate from Security & sessions.** Security & sessions is
credentials and access: password, two-factor state, app passwords, live sessions.
Privacy & safety is how the app behaves towards the reader and towards senders:
what loads, what leaks, and what asks before it happens. A remote image, a read
receipt and an undo-send window all decide what reaches a sender, and none is a
credential.

Three warnings live in Privacy & safety, and **all three start switched off**: a
client that begins by interrupting is one people learn to click through, and the
first could not be on by default anyway — it measures against the domains that
count as yours, and with nothing configured every message is from outside.

- **Messages from outside** get a banner naming the sender's domain. Your own
  identity domains are always inside and are not configuration; anything listed is
  additional and covers its subdomains, matched on a dot boundary, so `example.com`
  covers `mail.example.com` and not `notexample.com`.
- **Sending outside** names the outside recipients and asks.
- **Sending to a large group** asks once the count crosses a threshold you set,
  counting people rather than headers.
- **Opening a link** asks before following a destination not on the trusted list —
  and *always* where the link's own text names one domain and its destination
  another, even when the destination is trusted. A domain can be trusted from the
  dialog, except on that mismatch. Non-http(s) links are left alone. A link in a
  plain-text mail is linkified and points wherever it likes just as readily.

The senders trusted with remote images are listed in Privacy & safety and can be
withdrawn one at a time. Settings **export** to a JSON file, **import** back, and
reset to defaults.

## Dates, times and locale

- **~620 locales** — every tag CLDR has real data for, each named in its own
  language and script, generated by probing `Intl` rather than hand-listed. The
  default comes from the locale Stalwart reports for the account, then the
  browser's.
- **Date order**: locale default, `22.11.2025`, `22/11/2025`, `11/22/2025`, or ISO
  `2025-11-22`. **12- or 24-hour clock**, applied everywhere.
- **Numerals follow the locale**, except under ISO 8601, which pins date and clock
  to Latin digits.
- Dates are **entered** through Gilbert's own pickers rather than the browser's,
  because browsers render `<input type="date">` in their own locale. Typing is
  lenient: `22.11.`, `221125`, `6:23pm` and bare ISO all parse. Editable date boxes
  are always Gregorian and Latin digits; non-Gregorian calendars are not
  implemented.

## Interface language

Twelve languages — English and eleven translations — chosen in **Appearance →
Language**, separate from the date-and-time locale: wanting German dates on an
English interface is a real preference, and so is the reverse.

| | |
| --- | --- |
| English | the source language, and what every other catalogue falls back to |
| Deutsch · Español · Français · Italiano · Nederlands · Português (Brasil) | Beta |
| Русский · Українська · 简体中文 · 日本語 | Beta |
| Türkçe | Beta, contributed by Hakan Arslan |

**All eleven translations are marked Beta.** The catalogues were produced by AI
against standard dictionaries and have not been read by anybody who speaks the
language, which is stated in Settings next to a link for reporting anything that
reads wrongly. A language loses the Beta mark when a speaker has read it and said
so, which is a deliberate act by a person and not something a percentage earns.

- **A missing entry renders its English source**, so deleting a bad line is a valid
  fix and a catalogue is never half-broken.
- **Plurals are asked for, never assumed.** `Intl.PluralRules` decides the form, so
  Russian and Ukrainian get their three (1 письмо, 2–4 письма, 5+ писем) and
  Japanese and Chinese the one they have, with counters doing the work a plural
  would: 通 for messages, 件 for conversations.

The interface language also feeds the *automatic* date locale, so 日本語 gives
Japanese month and weekday names without setting the region, and `<html lang>`
follows it. Only languages with a catalogue shipped appear in the picker.

## Themes

Two questions, asked separately: **which palette** and **light or dark**.

| Palette | |
| --- | --- |
| **Classic** | The plain light and dark the app has always had |
| **gilbert** | The palette this project's site is painted in, and what a new account starts on |
| **Dracula** | Dracula, and Alucard as its light half |
| **Gruvbox** | |
| **Rosé Pine** | Dawn as its light half |
| **Tokyo Night** | Day as its light half |
| **Catppuccin** | Mocha and Latte |
| **Solarized** | Light and dark are both original to it, and share one set of accents |
| **Ayu** | |
| **Kanagawa** | Wave, with Lotus as its light half |
| **Everforest** | The medium-contrast variant of each side |
| **Primer** | The colours behind GitHub's design system. Named for the system, not for GitHub, which has not endorsed anything here |

Every palette has both halves, so the theme switch in the account menu only changes
the side and never the colours. Accent colours sit on top of any of them. The ten
borrowed palettes are their own projects' work, used under the MIT licence — see
[NOTICE](NOTICE); only the published colour values are used, from each project's
own repository, recorded in `.palette-sources/palettes-upstream.md`.

**The shades between those values are derived, and every one is checked.** Gilbert
needs about thirty tokens and these projects publish between twelve and twenty, so
`scripts/build-palettes.py` computes the tiers and measures every text colour
against the surface it sits on — 4.5:1 for prose, 3:1 for borders and marks — and
lifts anything short, towards white on a dark ground and black on a light one. The
script refuses to write a palette that would not pass. **Twenty-one of the
twenty-two palette halves needed at least one lift** (Dracula's comment grey is
3.03:1 on its own background; Rosé Pine's gold is 2.7:1 on Dawn). Body text is
lifted the same way to the 7:1 Gilbert asks of the text a reader looks at all day;
Solarized Light moves 4.13 to 7.07 that way, and Primer needed nothing in either
half.

---

# Live updates and notifications

- **JMAP push over EventSource**, proxied by Gilbert's server so the browser never
  holds credentials. State changes arrive per type, and each store refreshes only
  what changed.
- **Polling behind it** for networks that cut long-lived connections, and
  reconnection on a fixed one-second heartbeat while the tab is open. Each failed
  attempt probes a cheap route: if it answers, the stream is blocked rather than the
  line, and the same catch-up runs there too. On desktop the header shows connected,
  reconnecting, or off and polling, and the dot beside the brand says on hover
  whether the server answered or could not be reached.
- **Unread count in the tab title and painted onto the favicon.**
- **Desktop notifications** for new mail and chat while Gilbert is open and the tab
  is in the background, with a sound. Both switches start **on** for a new device;
  the system permission is asked for in the gesture that turns a switch on.
- **Web Push** for notifications with Gilbert **closed**, where the server signs
  with VAPID (RFC 9749). Nothing in that path touches Gilbert's server — Stalwart
  talks to the browser's push service directly, so there is no relay. The
  subscription asks for **`EmailDelivery`**, not `Email`: a delivery is the only
  thing that wakes it, where `Email` also changes on every read, flag and move.
  Where the server also implements `emailpush`, the payload carries the message's
  `id` and `threadId` as well as sender, subject and preview, which lets a
  notification be tagged by message, offer Archive and Mark-read, and open the
  message; without it the notification says only that mail arrived. Nothing is shown
  while a focused Gilbert window is on screen. Offered only on a device you said was
  yours.
- **The subscription is one row per device, and it wakes for a group's mail and its
  chat.** A subscription belongs to the principal that registered it and is served
  for every account that principal is a **member** of. A group's mail wakes a closed
  Gilbert as a notification that names nothing; what is not built is the per-account
  payload that would name the sender, subject and mailbox. A chat message wakes it
  through `FileNode`, and the worker reads the newest nodes of the group's chat
  folder and announces what is newer than the watermark and not the reader's own
  (ADR 0016, whose live-server probes stay owed). Read from Stalwart's source at
  v0.16.22.
- **A full account is not the end of notifications.** Stalwart allows fifteen
  subscriptions per account, shared with Gilbert's own server-side row, and the
  sixteenth create is refused `overQuota`. The client releases its own rows before
  registering, and on that refusal gives up one belonging to another browser —
  never verified first, then the one closest to expiring.
- **The switch says why it cannot be offered** where it cannot: a mail server with
  no push key, a browser with no Push API, and an iOS browser opened as a tab, which
  is told to add Gilbert to the Home Screen in Safari. The notification permission
  is asked for in the gesture that turns a switch on and nowhere else, and a
  permission the browser no longer holds an answer for is said out loud.
- The verification code a subscription needs is handed to an open tab, or left in
  the browser's cache under a key **anchored to where the app is mounted** for the
  next tab to collect.
- **The subscription is renewed on every app start**, because a JMAP push
  subscription expires — seven days is the ceiling. Renewal happens with a page
  open, because the service worker only wakes for an event and the event that would
  wake it stops arriving the moment the subscription lapses; the two-day renewal
  window means once a week is enough. A browser that dropped or rotated its
  subscription on its own is re-subscribed at the same moment. Registration is per
  browser, not per account.
- **A subscription is extended rather than replaced.** Stalwart keeps every create —
  a repeated `deviceClientId` does not replace the row it repeats (confirmed live
  on 0.16.22, 2026-09-16) — so a registration finds the row it already has, extends
  its `expires` where accepted, releases any duplicate of its own, and starts a
  fresh one only when the endpoint changed.
- **The rest of a build is fetched in the background.** The app page carries the
  list of its own scripts (written at build time, prefixed with the mount), and the
  service worker fetches what it does not hold, three at a time, on each
  navigation. Language catalogues are left out and nothing is fetched ahead when the
  reader asked the browser to save data. The kept copy of the app page is refreshed
  from every navigation and used only when the network is not there.
- **Stale build reload**: when the server starts serving a build the open tab did
  not come from, the tab reloads itself. The reload is unconditional once the
  versions differ; the version is asked for on a slow poll while visible, on
  becoming visible again, on the push stream dropping, and on every navigation. The
  session survives, because it lives in the sealed cookie and the server's session
  file.
- **Crash recovery**: an error no boundary catches unmounts the whole tree, so a
  root boundary catches it, writes the crash to `localStorage`, and reloads.
  Automatic reloads are bounded — never while the page is under a minute old, and at
  most two per ten minutes per tab. Lazy views carry a twenty-second load timeout.

---

# Platform

- **Installable PWA** with a service worker: the app shell is cached for
  installability and fast loads, API requests never are, and navigations are
  network-first with the shell as fallback. The worker's script is asked for hourly
  with the cache bypassed. The manifest carries Gilbert's own icons (192 and 512 for
  `any`, a third `maskable`) and default-theme splash colours; the artwork is the
  mark on its own dark navy, not the wordmark.
- **Install from the app's own banner and menu.** On a phone a dismissible banner
  sits under the top bar and the account menu carries the same command. The command
  is **Install mobile app** while there is something to install — it shows the
  browser's prompt (`beforeinstallprompt`, captured at start-up) or, where the
  browser has none, Safari's Share-sheet steps or the browser's own menu — and
  **Mobile app** once installed. The dialog keeps the app current (**Update now**,
  enabled only when the server serves another build) and turns notifications on for
  the device (`lib/installApp`, `lib/staleBuild`, `lib/webpushEnable`).
- **Manifest shortcuts** for Compose, Calendar and Contacts.
- **One window, not one per launch.** A `mailto:` link, a shortcut or a
  notification opened while Gilbert is running arrives in the running copy.
- **The unread count on the installed app's icon.** Web Push marks the icon while
  the app is closed, with a dot rather than a figure, because a push carries the new
  mail rather than a total; the next tab to open writes the real count over it.
  Unsupported browsers and iOS show nothing until permission has been granted.
- **In the share sheet** — share a photo, a link or a file from any other app and
  Gilbert opens a draft that holds it. The subject comes from the shared title, the
  text and link become the body above your signature, and files are attached and
  start uploading. It addresses nothing. A share is a POST, handled by the service
  worker, which leaves the body for a tab and redirects to the app; that also lets a
  share to a signed-out Gilbert wait through sign-in. A share nobody collects
  expires after ten minutes. With the agent unregistered the share is lost. Android
  and Chromium only; iOS implements no share targets.
- **Acting on a notification.** Archive and Mark as read sit on the notification
  itself; `maxActions` is two on Android, so these are the two a phone shows. Reply
  is deliberately not among them. The service worker's same-origin call carries the
  session cookie. The agent is plain JavaScript outside the bundle and cannot read a
  catalogue, so the app writes the language, account and archive folder down for it
  whenever they change; with no such note the notification appears with no action
  buttons rather than English ones over a guessed mailbox. An expired or signed-out
  session comes back as a refusal, and the notification says so.
- **Share** — a message, or one attachment, handed to the operating system's share
  sheet instead of to the filesystem, on the message menu, each attachment row and
  the file viewer. A message shares as text rather than as its `.eml`. Drawn only
  where the browser has Web Share (absent on desktop Linux and Firefox); where the
  share cannot be made, the download it sits beside happens instead.
- **`mailto:` handler** — registered from Settings › General for the browser (needs
  HTTPS; Safari does not support it), and declared in the manifest so an installed
  Gilbert is offered by the operating system. Links arrive with recipients, Cc, Bcc,
  subject and body filled in.
- **Deep links**: `/mail/:mailboxId?/:threadId?`, `/search/:threadId?`,
  `/calendar/:view?/:date?`, `/contacts/:id?`, `/files/:nodeId?`,
  `/settings/:section?` — every view, down to an open conversation, is addressable,
  and the back button works.
- **Printing** a message uses the browser's own print.

## Keyboard shortcuts

Gmail-style and always on; there is no setting to enable them. `?` shows the list
anywhere. Two-key sequences (`g` then `i`) have a 1.2-second window. Nothing fires
while you are typing, or while a dialog or menu is open, except three composer
bindings. Shortcuts register per view. `Ctrl` is `Cmd` on a Mac, and the help dialog
shows which it picked.

| Where | Keys |
| --- | --- |
| Global | `?` help · `/` search · `c` compose · `g i/s/t/d/a` inbox, starred, sent, drafts, all mail · `g l/c/f/k` calendar, contacts, files, settings |
| List | `j`/`k` next/previous · `o` open · `u` back · `Esc` back or clear selection · `x` select · `Ctrl+A` select all |
| Acting | `e` archive · `#` delete · `!` spam · `s` star · `Shift+I`/`Shift+U` read/unread · `v` move · `l` label |
| Conversation | `r` reply to the sender · `a` reply all · `f` forward · `n`/`p` next/previous message · `]` archive and open next |
| Composer | `Ctrl+Enter` send · `Ctrl+S` save draft · `Esc` close, saving |
| Calendar | `t` today · `n`/`p` next/previous · `d`/`w`/`m`/`a` day, week, month, agenda · `c` new event |

Aliases exist and are left out of the in-app list on purpose: `↓`/`↑` for `j`/`k`,
`Enter` for `o`, `y` for `e`, `Delete` for `#`. Contacts and Files define no
shortcuts of their own; the global set still applies.

---

# Security and privacy

## The browser never holds a credential

Sign-in posts the username and password once. The server seals them with a key
derived from the session's own cookie secret combined with the app secret — `secret`
in the installation's own document, `APP_SECRET` in a process with no boot
(HKDF-SHA256 → AES-256-GCM) — and keeps only the ciphertext plus a hash of the cookie
secret. A stolen session file cannot be turned back into passwords without also
holding the users' cookies. The browser gets an `HttpOnly`, `SameSite=Lax`,
`Secure`-when-HTTPS cookie and nothing else; every JMAP call goes through
`/api/jmap` on the same origin.

## "This is my own device"

A tickbox on the sign-in page, **unticked by default**, because the answer that
costs something to get wrong is the one that assumes the machine is yours.

| | Unticked | Ticked |
| --- | --- | --- |
| Stays signed in | until the browser closes | up to 30 days (`SESSION_REMEMBER_TTL`) |
| Idle sign-out | after 5 minutes | none |
| Kept on the computer | nothing | settings cache, recent addresses, username |
| Background notifications | refused | available |

Local storage is gated on that answer for **reads** as well as writes. Signing out
clears the settings cache and recent addresses and tears down the push subscription,
whichever answer was given. The idle timer exists because `beforeunload` was removed
from browsers years ago and **no event fires at all** for walking away from a
signed-in screen.

## Server hardening

- **CSP** on the app: `default-src 'self'`, `script-src 'self'`, `object-src
  'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`.
  Proxied blobs get a far stricter one — `sandbox; default-src 'none'; style-src
  'unsafe-inline'; img-src data:`.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy:
  no-referrer`, a `Permissions-Policy` denying microphone, camera, geolocation,
  payment and USB, `Cross-Origin-Opener-Policy: same-origin`, HSTS over HTTPS, and
  `Cache-Control: no-store` by default.
- **CSRF**: every API call must carry `X-Requested-With: gilbert`, and any request
  whose `Sec-Fetch-Site` is not same-origin is refused outright.
- **Rate limiting** on sign-in, keyed by IP *and* IP+username, with `Retry-After`;
  a separate limiter guards the endpoints that check a password. An **IPv6 address
  is counted by its /64**. The flood ceiling is consulted **before the body is
  read**. Client IP is taken from `X-Forwarded-*` only for peers in
  `TRUSTED_PROXIES` (loopback and the private ranges by default).
- **Body limits.** Every API route that reads JSON takes at most 64 KiB, except the
  data path (`/jmap`, `/upload`), which is capped and streamed; sign-in is capped at
  16 KiB. A checked `/jmap` body is bounded three ways: 4 MB each, four reads per
  session at once, and 32 MB across everyone, where exceeding the shared budget
  answers `503 busy`.
- **Upload and timeout limits** on the proxy (`MAX_UPLOAD_BYTES`,
  `UPSTREAM_TIMEOUT`).
- **Byte ranges on a download**, so a PDF preview pages through a file: a
  well-formed `Range` is forwarded, the 206 and its `Content-Range` passed back, and
  the proxy advertises `Accept-Ranges: bytes` itself. An unservable range comes back
  as the whole file with a 200, never a 416, and a malformed one is dropped.
- **The bundle is served precompressed.** The build writes a Brotli and a gzip copy
  of every compressible file (`scripts/precompress.mjs`), and the static handler
  hands over the smallest the browser accepts, with `Vary: Accept-Encoding`. Every
  static file carries an `ETag`, and a matching `If-None-Match` gets a 304. A
  precompressed copy older than its source is ignored.
- **Attachment and proxied-image responses are `no-store` on a device that is not
  the person's own.** Filenames attached to a message are shown and saved with
  **direction controls stripped**, so a sender cannot make one read as another.

## The image proxy is SSRF-safe

Approved remote images are fetched by the server, so every request is checked before
it is made: the hostname is resolved and **every** answer must be acceptable — one
bad record fails the fetch — and private space is refused in both families (RFC
1918, loopback, link-local, CGNAT, multicast, IPv4-mapped IPv6, unique-local, and
NAT64). Responses are capped at 15 MB, served under the sandbox CSP above, and
identified by their own user agent.

## Self-service credentials

Over Stalwart's own registry objects, so there is no administrator in the loop:

- **Change your password.** Where the account is backed by an external directory
  (LDAP, SQL, OIDC) Stalwart refuses, and Gilbert shows the server's own reason.
- **App passwords** — create, list and revoke a separate password per mail app or
  device. Creating one **asks for the account's current password**, because it is a
  standing credential that outlives the session. The password is compared against
  what the session already holds, so a wrong guess never reaches Stalwart's
  auto-ban. Minting one has a **rate-limit budget of its own**.
- **Active webmail sessions** — see them, and revoke every session but this one. A
  session is grouped by **the account Stalwart names on the server it lives on**,
  not by the string typed at sign-in.
- **Signing out leaves nothing of the session behind**, composers included: a send
  still inside its undo window goes on the way out, then every open composer is
  closed.
- **Two-factor**: an account that has it can turn it **off** here. Turning it **on**
  is not offered, and there is no code field on the sign-in page. Stalwart accepts
  a TOTP code only through an OAuth flow and offers no password grant, so **an
  account with 2FA signs in with an app password**. A rejected sign-in that carried
  a code says exactly that rather than "invalid credentials". Doing it properly
  means implementing OAuth; that is in [ROADMAP.md](ROADMAP.md).

## Checking a signature

A signed message says who signed it, and Gilbert checks whether that holds up. This
is S/MIME only, and it stops at reading: nothing here signs, encrypts or decrypts.

**What it checks.** For a `multipart/signed` message carrying a PKCS#7 signature,
the exact bytes of the signed part — headers included, canonicalised to CRLF — are
hashed and compared against the `messageDigest` the signature covers, and the
signature over the signed attributes is verified with WebCrypto against the
certificate travelling inside the message. RSA (PKCS#1 v1.5) and ECDSA over P-256,
P-384 and P-521 are supported, with SHA-256, SHA-384 or SHA-512.

**What a check is allowed to claim.** A browser has no system trust store and the
certificate arrives inside the message, so anyone can self-sign as anyone. A
verified signature proves only that whoever wrote the message held the key attached
to it, which is why Gilbert never renders the bare word *verified*. What makes it
worth anything is remembering: the first signed message from an address pins that
certificate's fingerprint in your settings, and later ones are compared against it —
trust on first use, needing no certificate authority.

| what happened | what you see |
|---|---|
| first signed message from this address | *"Signed by X, seen here for the first time"* — grey, and deliberately not congratulatory |
| same certificate as before | *"the same signer as before"* — the only case that gets a tick |
| **different certificate than before** | **loud**: both names, and told to check by some other route |
| valid signature, certificate for a different address | **loud**: the signature is not for this sender |
| body changed after signing | **loud**: the signature does not check out |
| signed, but uncheckable | grey, and careful to say *could not check* rather than *did not check out* |

The pins live in the account's settings file rather than the browser, so the same
correspondent is not greeted as new on every device, and a pin records the message
that created it. A signer that changed, one whose certificate does not name the
sender, or one already expired is never pinned.

**What it will not do.**

- **OpenPGP is not checked**, and says so by name rather than as an unknown format.
  The signature does not carry the key, and fetching from a keyserver or WKD would
  leak who you correspond with to a third party — the exact thing the image proxy
  exists to prevent.
- **No chain of trust.** Nothing is validated against a certificate authority, no CA
  bundle is shipped, and revocation is not checked.
- **SHA-1 signatures are refused**, not reported as valid.
- **RSA-PSS is declined** rather than attempted, because guessing the salt length
  wrong would report a good signature as bad.

The verifier is a separate bundle chunk, loaded only when a message's structure says
it is signed.

## Privacy by default

The image proxy is on and remote images follow the shipped *Always show* policy
through it, read receipts are never automatic, there is no telemetry, no analytics,
and no third-party requests from the app (the CSP would refuse them). The only
network calls the browser makes are same-origin.

---

# Running it

Installing, running, configuring and operating Gilbert is [INSTALL.md](INSTALL.md);
building and contributing is [CONTRIBUTING.md](CONTRIBUTING.md); the environment
reference is [`.env.example`](.env.example); the decisions behind the configuration
are in [docs/adr](docs/adr/README.md).

---

# What it does not do

The full list with reasons is [ROADMAP.md](ROADMAP.md). In short: no snooze (nothing
in JMAP or Stalwart supports it, and Gilbert holds no password to act on a mailbox
while you are away), no language yet checked by a native speaker, no two-factor
sign-in without an app password, no sharing of mail folders (the server stores the
share and never delivers it), no public links (JMAP shares with accounts on the same
server, and Gilbert has no storage of its own to mint a link from), and no
per-occurrence *this and future* edits (the server refuses them).
