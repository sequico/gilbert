# Features

What Gilbert is, in one paragraph, is the top of [README.md](README.md); what
it is *for* — operations rather than sales, deliberately no CRM and no sales
functions — is [there too](README.md#what-gilbert-is-for). This is the
inventory of everything it does, at the level of detail someone evaluating it
or working on it actually needs.

It is ordered the way this project cares about it: **Gilbert's own** first —
the groups, the chat and above all the agents — and the client the mail core
derives from after it.

This is the inventory. Two files sit beside it and answer different
questions:

| | |
| --- | --- |
| [ROADMAP.md](ROADMAP.md) | What Gilbert deliberately does **not** do, and why |
| [KNOWN-ISSUES.md](KNOWN-ISSUES.md) | What was verified live, and where Stalwart departs from a spec |

Written against the tree at Stalwart **0.16.21**, which is the version the live
instance runs. Behaviours carrying an older version below were checked against
that one and have not changed since; where 0.16.21 changed something, the entry
says so and names both. Gilbert
requires 0.16 or newer and refuses older servers at sign-in, by name.

## The shape of it

Gilbert is a single-page React app plus a small Node server that speaks JMAP
to Stalwart on the browser's behalf. There is no IMAP, no SMTP, no database, no
search index and no cache tier. Every durable thing — mail, calendars,
contacts, files, filters, and Gilbert's own settings — lives in the mail store.
The container is disposable, and with `IMMUTABLE=1` it has nothing writable at
all.

That constraint decides most of what follows. Where a feature looks unusual,
it is usually because the obvious implementation would have required Gilbert
to keep something of its own.

Everything below belongs to one of four blocks — **gilbertmailer**,
**gilbertserver**, **gilbertagents** and **gilbertstalwart** — named the way
`README.md` defines them, which is the only place they are defined. The names
are vocabulary, not sections: a feature is written where a reader looks for it,
and the block it belongs to is said where that is not obvious.

That same section of the README draws the line to upstream, and it is short on
purpose: `gilbertmailer`, and inside `gilbertserver` the layer that serves it,
came from upstream. Everything else in this file is Gilbert's own — which is
most of it — and has no upstream to be compared against.

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
| Push subscription fan-out | The same live updates with no upstream stream per tab; the callback origin is derived from the request, behind a trusted https proxy; a change re-reads what is on screen rather than every listing ever opened | Falls back to the EventSource relay |

`urn:stalwart:jmap` is advertised per **account**, not session-wide, and the
submission capability keeps `futureRelease` in the same place. Both are read
out of `accountCapabilities`; reading them at the top level finds an empty
object and silently disables the feature, which is why the mock reproduces the
per-account shape.

---

# Gilbert's own

Gilbert is a product built on Stalwart rather than a mail client with extras
bolted on. What follows in this first part is what this project owns and
maintains, and it is where the work goes.

The **group** is the unit everything else is built around: a group mailbox is an
account of its own on the server, and what it owns — its chat, its label
catalog, its calendars and files, its agent's documents — lives in that account
and belongs to it from creation, shared with its members rather than copied to
them. **Chat** is one conversation per group. The one thing a member cannot do
with what the group owns is **end its mail**: the mail server tells one member's
delete from another's by nothing and offers no rank inside a group, so the
refusal is this client's rule, and ending a message — out of Deleted Items or
Junk Mail, by emptying either, or by deleting a folder with its mail — is an
installation administrator's decision (ADR 0015). Everything else a member does
to move mail around still works. And **Agents** is the largest
thing here: an agent fleet that acts inside mail and file storage on a group's
behalf, with its own identity, its own permissions and its own audit trail. That
section is the detailed one; the two beside it are the surfaces a member and an
administrator actually touch.

# Agents

Gilbert's own agents: a Stalwart account of its own — a *structure agent*, e.g.
`gilbert@…` — that acts inside mail and file storage for the groups the
operator has granted it (ADR 0003). Gilbert's own agents now, external agent
fleets later.

- **The agent is a mailbox.** It exists as an ordinary account in Stalwart's
directory, created by the operator in Stalwart's own administration, and it is
**granted** on a group the same way any principal is. Membership is the
grant: there is no second, in-product activation switch, so a group the agent
can see is a group it works for, and a group it cannot see is untouched. The
Gilbert admin surface reads that membership from the Master's own session in
Stalwart and shows it; it never writes one, and no screen asks anyone to
declare it.
- **The agent's address and password are the deployment's.** The operator names
  the agent with `GILBERT_AGENT_ADDRESS`, beside the account's own password in
  `GILBERT_AGENT_PASSWORD` — the account's own, not an app password: the agent
  signs in as itself — in the environment of whoever starts the server and the
  agent. Nothing in the product names it and nothing is recorded for it: there
  is one place the pair lives, and it is the deployment. Both processes read the
  same pair: the agent opens its session with it, and the admin surface signs
  in as the agent with it, so no screen carries a secret. It is the boot's
  handshake, so absent or incomplete the deployment does not come up — the boot
  names the variable that is missing and exits, and a pair Stalwart refuses
  fails the Master's sign-in the same way. **Admin → Master** reports the state
  it finds, and the agent process started on its own is the other half of the
  sentence: with nothing named it warns once, keeps running and serves nothing
  instead of refusing to come up.
- **What the fleet serves, per group.** The accounts Stalwart lists the agent as
  a member of, and nothing else: a group is served when it holds the agent, so
  the grant is Stalwart's and there is no second record to keep. The surface
  reads the Master's membership from the Master's own session and shows it, rather
  than writing one or asking anyone to declare it. The same answer says which
  agents are serving a group: a claim is per account, so an agent names the
  groups it is holding in its heartbeat, and the surface reads one group's
  agents off that rather than listing a fleet with no group attached.
- **An automation can be run now, on a message a person names.** *Run now*
beside an automation asks for one run, on the newest message of the group's own
inbox: the ask writes a job, and the agent holding the group runs it on the
automation's own terms — its capability allowlist and the group's review policy
still decide, and the audit line says it was asked for. It answers the question
the surface could not: an automation that is not armed, one that is not about
mail, a group with no message to run on, and a group nobody is holding are four
different sentences, and none of them is written into the group's audit, because
none of them is a run that happened.
- **A withdrawn grant is reported, and the group stops being served.** The
agent re-reads its session at most once per poll interval — a minute, a third
of a lease, so no new setting arrives with it — and an account it was serving
that the session no longer lists *is* a withdrawal, because the session is the
whole of a grant. From that pass on the group is not served, and the agent
writes the loss once into its **own** account: the group's name, the account it
was holding, and when it noticed, shown on the admin surface beside the fleet
rather than in a log nobody tails. The report says what the agent was
holding; what a withdrawal left unfinished stays in the group's own audit,
which the agent can no longer read — the record never claims to know it. And
nothing is written or deleted in the withdrawn group on the way out: the claim
is left for its lease to lapse, which is how a withdrawal ends.
- **Three levels of prose, and none of them grants anything.** What an agent is
told is written in three places, in the order it reaches the model: the
**installation's own rules** (Admin → Master, held in the Master's account,
carried into every call of every group), a **group's standing instruction**
(written for that group), and the **automation's own instruction** (written
beside the trigger it belongs to). Each says how to work; none of them widens
what a run may do, because the grant is the automation's capability list, checked
on every answer the model gives. The installation's rules exist so the house
rules a company states once do not have to be repeated in every group's
instruction, and all three sit in the prompt's stable head, so carrying them into
every call costs a cache hit rather than a miss.
- **The group's standing instruction.** One text per group, written in the
admin surface — which reaches a group's own files as the installation's agent,
so an administrator needs the agent's grant on the group rather than their own
membership — and handed to the model on
**every** call the group's agent makes: after the installation's own rules and
the group's notebook, and before the automation's own instruction and the
message it is reading. It says how the agent should work for this group
(language, tone, conventions) so that does not have to be repeated in every
automation. It can steer and it cannot grant:
what an automation may do is its capability list, checked on every answer the
model gives, and nothing written in the instruction widens it. An empty text
removes it.
- **A group sets who its runs stop for, once.** One document per group, written
beside the standing instruction, with two choices: **when a person has to
agree** (every run, below a confidence, or never) and whether a run may **reach
outside the group without a person** — which is the group's own raise of the
consent floor, off until somebody turns it on. One policy for the whole group
rather than one per automation, because two automations of a group are the same
team's work on the same correspondence and a policy repeated per automation is a
policy that drifts apart. The threshold is not a field: "run it unattended when
the model is confident" is the behaviour an author picks, and what that means is
one constant rather than a decimal every author invented. Neither choice can
lower a floor that is in code — an action that cannot be undone asks whatever is
chosen, and one that reaches outside the group asks unless the group has said
otherwise — and a group that has written no policy runs on the confident
reading: an in-group action the model is sure of goes ahead, an unsure one stops
for a person.
- **One bootstrap secret, and the deployment holds it.** The agent
authenticates as the agent with the account's own password
(`GILBERT_AGENT_ADDRESS`, `GILBERT_AGENT_PASSWORD`). Nothing derives it, nothing
impersonates at boot, and nothing durable is kept on the Master's disk: the
session is re-established at every start, so the container stays disposable and
`IMMUTABLE=1` holds. The product neither mints nor rotates a credential, and it
keeps no second copy of the pair. Rotating it is the operator's act in Stalwart,
and it lands on the deployment: the variables are read at boot, so a restart is
what carries the new value.
- **Nothing is watched at runtime; a change lands on the deployment.** The
address and the password are read once, at boot, so changing either means
restarting the processes. Membership is the
one thing re-read while the agent runs — at most once per poll interval — so a
group Stalwart no longer lists the agent for stops being served within it
(below).
- **Three admin surfaces, not one trying to answer everything (ADR 0003).**
  **Master** is the installation, configured once: identity, the one model and
  its bounds, the rules that hold in every group, and the plain list of granted
  groups. **Group Agents** is the agent *in one group*, behind a single picker
  and read as one subject before any section is opened: its header names the
  agent serving the group and how much of it is armed, and its four sections are
  **Behaviour** (the standing instruction every call carries and the policy its
  runs stop for), **Automations** (one rule per trigger), **Memory** (the
  notebook its calls are given) and **Activity** (the audit trail and the agents
  serving the group), beside a control that makes sure the group's reserved
  label catalogue exists. The automations document is a section of the agent's
  behaviour rather than a peer of its configuration documents: it is up to four
  independent rules — email, file, chat, schedule — each with its own
  instruction and allowlist, each pinned by `ruleId`/`ruleVersion` on the jobs
  and audit that reference it, and each readable by the group's own members.
  **Approvals** is cross-group oversight: what is waiting for a person and
  what the fleet has done, across every granted group at once, read-only by
  construction — an operator still answers a paused run in the group's own
  chat, never on this surface. Master's own Groups list is a plain read of
  Stalwart's membership with a link into each group's Group Agents workspace,
  not a second table of what the agent does there. Master also says whether
  the Master may read a group's roster at all — `sysAccountGet` and
  `sysAccountQuery` on its own account, which the built-in user role does not
  carry — because that is the one fact that decides whether the chat's `@`
  offers a group's members or the people who have already written (ADR 0005),
  and it is an operator's grant to give.
- **An automation document this build cannot read is replaced automatically.** A
  group whose `agent/rules.json` is valid JSON but not the shape this build
  reads — a document an older version wrote, or a hand edit — is not shown as a
  group with no automation and does not take its surface down: the
  administration's read of the group (and `/admin/groups/:name/agent/rules`)
  replaces it with a fresh, empty one in the current format, conditionally on
  the state just read so a valid document written in the window is never
  clobbered, and says so once on the read that did it. The member door reports
  the state and never writes: the pen that heals is the administration's. The
  authoring save overwrites such a document too, rather than being blocked by it
  forever. What does **not** change is the executor's reading — it still refuses
  to run a document it cannot read and records that refusal — because for a run
  "no automation" and "an automation nobody can read" are opposite answers,
  never the same silence.
- **An automation is three choices and a paragraph.** The admin surface authors
one document per automation, and what an administrator decides is: **when** it
reacts (one of four triggers), **what it does** (prose, the whole of what a run
is asked to do — the branching between one case of mail and another belongs in
that prose, not in a second automation), and **what it may do** (three areas —
mail, chat, files and documents — plus sending, which no area can ever grant).
Nothing else is asked for: an automation is named by its trigger rather than by
a field somebody fills in, it carries no filter to write, and the cadence of a
scheduled one is a preset rather than a number to invent. Two entries answer for
themselves instead of belonging to an area: **sending**, because every area
excludes anything the catalogue marks as leaving the group or as irreversible —
computed from those flags, so ticking "mail" can never be how a person grants
sending — and **doing nothing**, which is granted to every automation and is not
a behaviour at all. The document is validated against a JSON Schema
Gilbert publishes (ADR 0003), with the same validator and the
same schema on both sides, so what the form accepts the server accepts, and the
areas it paints come from that same catalogue. No new
rule language, no JSON to type by hand, and Sieve keeps the delivery-time
boundary.
- **One enabled automation per trigger.** An automation carries no filter, so
nothing in the document tells two of them on one trigger apart — and the
executor runs **every** enabled automation on a trigger against **every** item
that trigger produces. Two on one trigger would therefore answer the same
arrival twice, which is the rule the server refuses a group's document for, the
form prevents by offering only the triggers nothing holds, and the executor
reports once into the log and the group's chat if a document written by hand or
restored from a backup carries one anyway. A disabled automation is a draft and
may sit beside the enabled one.
- **An automation can be armed on a cadence.** A rule whose trigger is a time
  rides the same documents as any other: the next run of every armed rule is
  stored as a UTC instant in the group’s own scheduler document, so a restart, a
  deploy or a crashed container costs the wait and not the schedule — a
  replacement agent re-plans from Stalwart and re-arms. Each agent fires the
  entries of the accounts it holds, so two agents never fire each
  other’s runs, and the runs that vanish — the rule off, the rule gone — are
  recorded as missed runs rather than disappearing from the trail.
- **One shape, and the model decides.** An automation is a trigger, an
instruction and a capability allowlist — nothing else, and no
compiled plan: every run hands the instruction to the installation's model,
which answers with actions from the capability catalogue. The allowlist is what
bounds it — an answer naming an action the automation was not granted is
refused, so the prose steers inside the grant and never widens it — and every
run is audited. One model, configured once (provider, model, base URL and a
write-only key), serves every automation: nothing asks an administrator to
classify what a piece of work deserves. Beside it the installation states its
own bounds — the ceiling on one answer, how many hops a chain may run, how many
pages one run may hand the model — in the same document and the same panel.
A bound the installation has not set is the build's own default: the ceiling on
one answer is a constant, while how many hops a chain may run and how many pages
one run may hand the model are the document's `agent.chainHops` and
`agent.pages`. Both of the installation's own bounds are held to fifty
whatever the document or the environment asks — a value no surface could have
written is a value no run obeys, and the panel shows the number a run is held
to rather than the one a hand-edited document states. A file larger than the
byte ceiling a run reads is not
read, one split writes at most a hundred pages, and a page too large to hold is
rendered smaller rather than refused — all said in the run's own notes rather
than discovered as an outage. A deployment whose model cannot read an image says
so (`agent.vision` false in that document), no page is rendered for it at all,
and its runs are told that the page could not be read instead of being told one
was handed over.
- **A group has a memory.** Beside the documents a group already keeps, its
agent carries a **notebook**: the facts about the group that no automation
should have to repeat — how its mail is filed, what its clients are called,
which language the group works in, the exceptions somebody wrote down. It is a
document in the group's own account, so it survives a container, a deploy and a
replacement agent; the administration shows it as a list and lets an
administrator add, correct and remove one fact at a time; and it sits in the
prompt's stable head, so carrying it into every call costs a cache hit rather
than a miss. A run writes it too: **`notebook.write`** adds a fact, corrects one
by its id, or removes one by writing it with no text, gated and fenced the way
`file.write` is — so the agent distils what it learned into the cheap head
instead of re-reading the correspondence. It steers and it never widens: what
an automation may do is its own capability allowlist.
- **A run can look the group's state up.** The deciding call may answer with a
  lookup instead of actions, and the agent reads it in the group's own account
  before deciding (ADR 0020). The catalogue is the whole group, not one label:
  its **mail** and its **chat** by the **search grammar the client's own search
  box speaks** — `is:starred`, `is:unread`, `from:`, `in:`, `label:`,
  `has:attachment`, dates, sizes, quoted words — one **message** by the id a
  listing gave, its **folders**, its **labels**, its visible **Files** (one
  level, or the whole tree under a folder, filtered by name) and one **file** by
  the path a listing gave. The grammar is one definition in
  `server/src/shared/search.ts`, read by the client and the agent alike, so a
  new kind of question is a query rather than a new branch of code. Listings
  hand over names, ids and headers and reads hand over one item's text, each
  capped — the index is cheap and the content is bought only where it is needed
  — and the prompt states the two steps, so a run reads what it listed instead
  of answering a question about mail with a sentence about its own fields. The
  prompt's system message is byte-identical on every call, so the provider's
  cached prefix survives the whole run. The lookups a run made ride its job and
  its audit line, so "what did it read" is answered from a document.
- **A reading beside the prose.** Beside the instruction field, **Ask the model
to read it** sends the draft and what it is about, the installation's rules, the
group's instruction
and its notebook to the installation's model, which answers in words about the
gaps. It is not a run: nothing is compiled, nothing is stored, there is no job
and no claim — a call with a timeout instead of a lease, thinking off — and its
tokens are counted in the **Master's account** as authoring rather than in a
group's ledger. Its refusals travel as codes like every other refusal, and the
answer is model prose shown as prose. What it may spend is the installation's
own month (`agent.authoringMaxPerMonth`), counted from the authoring
document and refused before the call rather than after it; two readings asked
for at the same moment can both pass it, and a reading the month could not
record says so rather than being lost.
- **Documents, read by the model that has eyes.** A run can act on a PDF: split
it into pages, merge them, extract one, and *read* — a PDF's own text layer, a
`.docx`, a workbook (`.xls` and `.xlsx`, read sheet by sheet, one sheet
counting as one page), a text file (`.csv`, `.txt` and the other
plain-text types, read as they stand: no delimiter parsed, no column named), or
an image (`.png`, `.jpg`/`.jpeg`, `.gif`, `.webp`). A
text file or a workbook longer than the 200 000 characters one reading
carries is handed over as the beginning of itself, and the run is told so. A
page that carries no text layer is **rasterised**: the executor
renders it to an image in the process (a WASM PDF engine — no canvas, no native
build, no child process) and the page rides that run's call as volatile content
in the tail, so the prompt's stable head is unaffected and an image is never a
cache hit. An image file carries no text layer by definition, so it needs no
rasteriser and rides the same way as its own bytes, sniffed against the four
formats' magic numbers rather than trusted from its name or its declared type.
A vision request carries images and not documents, which is why a scanned page
is rendered rather than handed over; how many pages one run may hand over
is bounded (`agent.pages`, eight by default) rather than left to the
file's size, and a document longer than the bound is read as the first pages of
it — which the run is told, so a part of a document is never presented as the
whole of it. There is deliberately no OCR engine — a page that is only pixels is
the model's to read — and no `.docx` writer. Everything happens in memory,
because the deployment has no writable filesystem.
- **What the work costs, in counts.** Every run records what the call spent —
tokens read from cache, tokens read fresh, tokens written, and whether the run
paid for the model's chain of thought — beside the work it did, and a run whose
provider reported nothing is counted as **uncounted** rather than folded in as
a zero: a reading that understates the bill is worse than one that admits what
it does not know. Where a group's automations are read, that group's own use is
shown; where the fleet is read, the installation's total with the split per
agent. The counts are tokens, never money — a price list belongs to a vendor and
changes without asking — and the total is a floor whenever a group's audit could
not be read, which the surface says instead of hiding behind it.
- **One automation's work can wake another, and a chain is bounded.** That is the
point of automations rather than a side effect: "file the invoice where the
client's name says, then read it and tell the group" is two automations passing
work along, and the hand-off travels through the group's own documents — a file
written into its Files wakes a file rule, a decision answered in its chat closes
the run that was waiting. Every run records the job that woke it, a chain runs
**five hops** (the number is the installation's, `agent.chainHops`),
and the sixth is **refused loudly**: no job, an audit entry whose outcome is
`refused`, and a line in the group's chat naming the automation and the bound.
A cycle of automations that wake each other therefore ends by itself, at the
bound, with a reason a person can read.
- **Labels, not folders.** `G-needattention`, `G-processed`, `G-awaiting`,
`G-rejected` mark Gilbert's processing state on the individual message; the
catalog is created from the Group Agents workspace once the grant exists —
idempotently, so asking again when it is already complete adds nothing and
says so. State is per
message: a reply arriving in an already-processed thread starts unlabelled and
is evaluated on its own, and it is shown on that message — never aggregated
onto a thread or list row, and never offered in the manual label picker, which
stay the reader's own labels. Moving a message is a separate, content-driven
action; the agent never moves mail just to record a state.
- **What it saves, a person can find.** An automation that extracts attachments
writes them into the group's own Files — in the folder the automation named, or
the one the model chose; when neither did, into the
`Needs attention` folder rather than loose in the root. A name already taken
there is that person's file: the run writes `2-note.txt` beside it and reports
the name it used, and it never replaces what somebody filed. Gilbert's own
documents (automations, jobs, decisions, audit) stay in the hidden `gilbert`
folder, which is where they belong and where the Files view deliberately does
not look — the name is the whole rule: the folder is found by it, and a path
that names it is refused as a destination in Files.
- **A run is bounded by what it was granted.** An agent that loses its unit
mid-run stops before anything leaves the process rather than writing results
its successor will write again; an approval is consumed exactly once, so two
answers arriving together cannot send the same mail twice; a run executes the
version of its automation it was created from, and one whose version is no
longer the current one is recorded as a failure rather than run, because a run
never executes a version nobody approved; and the audit records
what a run was about to do before it does it, so an effect never exists without
a line that accounts for it.
- **Approvals happen in the group's chat.** A run the group's policy stops for
pauses, writes a decision, prepares the draft in the group's own Drafts (kept
unread so a person sees it) and posts the proposal in the chat. Any member may
answer in words; the conversation is the interface, not a button. Nothing that
leaves the group is ever sent on a guessed approval — a send reaches outside the
group, so it always needs explicit consent, whatever the policy says.
- **The agent is its own process.** The same image and codebase as the server,
a second entrypoint (`node server/dist/agent/agent.js`), never a replica of the
web tier. It
holds the Master's event stream, wakes on it, and reconciles from the last
state it recorded; polling is the fallback after a lost stream. Work claims
live in the documents themselves, so no coordinator exists and none is needed:
one process per account, several accounts per agent, and a crashed agent's
claims are re-taken by whoever is running, together with the work it left mid-run; a
run nobody comes back for is recorded as a timeout rather than as a failure,
because nothing reported one — the process that would have is gone. It answers
a health probe when the deployment names a port (`agent.healthPort` in the
installation document), reporting the accounts it actually holds, so a restart
policy can tell "running" from "running and serving nothing". **The server starts
one beside itself** when the deployment names an agent (ADR 0003), so the one
command that starts the web tier is an installation that also works;
`agent.inProcess` set to false in the installation document is how a deployment
keeps the fleet in a process of its own.
- **Members see, never change.** Next to the group's chat, an indicator opens
the group's agent surface: which agent works for the group, what instructions
it carries, what it has done. Everything a member reads lives in the group's
own account, so a member added later sees all of it; nothing there is editable
from the product.
- **Every member reads what the agent is told and what it does.** The panel
behind the AI indicator answers with the group's own documents, read through the
member's own session on that group — the same one the chat uses — so it is open
to every member and not only to an administrator: the group's standing
instruction as text (who last wrote it, and when), and each automation as a
short block — name, what wakes it, how it is reviewed, whether it
is on, and the instruction it carries, in words rather than as a JSON dump. A group with
no instruction says so instead of showing a blank, and one sentence in the panel
states that only an administrator of the group changes either. Members read the
automations without their capability allowlist and without the authorship
stamps; nothing on that path writes.
- **The agent says hello once.** A group the agent has been granted but has
never spoken in hears from it: a chat message — "Hi all! Gilbert here, at your
service." — posted when an agent takes the group's claim. The greeting is
itself proof that an agent works in the group, readable through a member's own
session where the operator's grant list is not, so the panel stops reporting an
agentless group the moment the agent arrives.
- **Where the documents live.** Rules, jobs, decisions, claims, the schedule
and the audit trail are documents in the group's own `gilbert` app folder —
what members may read. The agent's own account holds its configuration, the
provider keys and the agent heartbeats, each heartbeat naming the groups its
agent is holding. Nothing durable is kept anywhere else:
no database, no volume.
- **Failures are loud.** An unreachable provider, a refused key or a malformed
answer never skips work silently: the run is recorded in the audit, the
message lands in `G-needattention`, and the group's chat is told which
automation could not finish. The audit is one document per month per group,
kept twelve months and pruned a month at a time. The months live in the
group's own hidden `gilbert` folder, not in the Files a member browses: a
member reads them through the group's agent panel, an administrator reads the
same trail as a table in the group's own Activity section in Group Agents (or
merged across every granted group in Approvals' own Audit tab), and takes the
copy before the oldest month goes — that same section hands over every retained
month as JSON.
- **A refusal reads in the reader's language.** The admin surface answers a
refusal as a code and its parameters — never as a sentence — and the client
composes the sentence from the catalogue the reader's language loaded: a
language whose catalogue does not carry it reads the English. A code the build
does not know is read as the prose the answer carried, rather than given a
sentence of its own. Where an answer quotes the server that refused — a
session that could not be opened, an impersonation the mail server declined —
that text travels beside the code as a diagnostic, and is shown as one.
- **Not in this layer**: agents for individual users (group agents only),
external agent fleets (a future decision; A2A stays the recorded candidate),
and mail notifications — the group's chat is the one channel.

---

# Administration

Product administration inside Gilbert, for users who are **Stalwart admins**
— the section itself is Gilbert's own, beyond the upstream client (ADR 0001).

- **The grant**: Gilbert admin equals Stalwart admin. At sign-in the server
  reads the account's own `/api/account` permission list and looks for the
  configured admin marker (`sysAccountCreate` by default, env
  `GILBERT_ADMIN_PERMISSION`); every privileged call re-checks it freshly,
  so a demotion lands on the next call of an open session. `isAdmin` is
  computed server-side (`server/src/upstream.ts` + `/api/account`), shown to
  the client as the shield in the top bar. There is no `gilbert-admin` group
  and no Gilbert-side capability registry to forge. Admin without Stalwart's
  `Impersonate` permission administers the install but cannot act on another
  user: the per-user writes fail closed on the permission.
- **Administration is a door, not a menu (ADR 0017).** The decision is made
  where the request is. `/api/jmap` refuses any body naming a registry object
  beyond the account's own — an allowlist of the self-service objects, so a
  registry object Stalwart adds later is refused by default — with the refused
  method named in the answer; ordinary mail, calendars, contacts and files are
  not inspected at all, and a session that may administer streams through
  untouched. **The allowlist authorises reads only**: every `x:` `set` is
  refused, because each object on it is a credential or a credential-shaped
  document and a write would mint something outliving the session — the client
  sends none, since password, app-password and 2FA changes go through
  `/api/account`, which asks for the account's password first. Every
  `/api/admin` route enforces the same conditions beside the
  marker. The installation can switch administration off entirely
  (`server.administration` in its own document, `ADMINISTRATION` for a process
  with no boot), which holds against a browser console and not only against the
  drawing of a menu; it can separately require the session to have been signed
  in on a device marked as its owner's
  (`server.administrationNeedsOwnDevice`, off by default — the sign-in form's
  box is about how long a session lasts, and a shorter one is not a less
  trusted one). The session tells the client which of the two applies, so the
  menu says why the entry is missing instead of losing it without a word.
- **An account is not acted on by one it outranks.** The admin marker is one
  permission, and it does not say whether the account about to be acted on
  holds *more* than the account acting. Stalwart does not re-check that for
  every write, so forcing a password change compares the two permission lists
  the server resolved and refuses an account carrying a permission the
  administrator does not (`target_outranks`).
- **Installation-wide policy editor**: the shield opens the administration
surface; its Policy section edits one JSON document with upstream's
`defaults` / `enforced` / `changes` shape (issue #207) and publishes it.
Publishing validates with the same rules, then writes the document into
every individual account's own Stalwart storage by impersonation — the
publishing administrator's account included — rather than into a file or
an environment variable, so it survives a redeploy and needs no volume
even under `IMMUTABLE=1` (ADR 0001). It applies at once and signs the
other signed-in clients out so their next sign-in reads it (`GET`/`POST
/api/admin/policy`, `GET /api/account/policy`; ADR 0001). **Each publish is a
job with an id** (ADR 0010): one id is minted before the first copy goes
out, every copy carries it beside the policy as `published: { id, at }`, and
the job itself is one document — `gilbert/publish-job.json` in the publishing
administrator's own app folder — holding when it started, who published, the
population the directory reported (how many accounts it listed, whether that
listing was the whole directory, and the total when the server stated one),
the accounts the policy reached, each account it did not with a code
(`impersonation-refused`, `no-files-account`, `write-failed`, `policy-moved`,
`directory-denied`), and whether the installation can be said to carry the
policy. Every per-account write is conditional on that account's own file
state, so a copy that would replace one somebody else just wrote is refused
(`policy-moved`) instead; a publish whose own record could not be stored says
`record: "failed"` rather than answering a job no later read can find; and
the editor reads the job back out of the account, so it names the last
publish it is showing even when this process never made one — and it says
`record: "failed"` out loud, because the next visit to the page shows nothing
about a publish that did happen.
- **Installation document editor**: the Installation section beside Policy
shows the installation's own configuration — one JSON document,
`installation.json` in the `gilbert` app folder of **the Master's own
account**, which is what a boot reads whole after signing in as the
Master — and publishes it. Both halves of that door act on the Master's
account by impersonation, so an administrator whose own account is
elsewhere administers the installation's document rather than one in their
own Files; a deployment that names no Master (`GILBERT_AGENT_ADDRESS`
unset) is refused as a value, with its own code, rather than opened onto
whoever is asking (ADR 0011). The read answers the text as the account holds
it, including a document this build cannot read, and whether there is one at
all; publishing validates with the boot's own validator and refuses anything
that is not a document, with the reason, before a byte is written: a document
with no app secret is refused too, because a boot cannot invent one and every
stored session is sealed with it. A publish writes through the same writer the boot reads
with, conditionally, and from the epoch the **stored** document carries rather
than the one submitted — a save from an editor opened before somebody else's
publish cannot move the stored epoch backwards, and a document that moved
while the publish was in flight is refused with its own code and left exactly
as it was. The answer says when it applies — the running process keeps the
configuration it booted with, and the next boot reads what was just written.
The three values that reach Stalwart (`STALWART_URL` and the Master's own
credential) are not in the document: they are what reads it
(`GET`/`POST /api/admin/installation`; `server/src/installationAdmin.ts`,
`server/src/shared/installation.ts`).
- **Forced password change**: an administrator can require a user to change
their password (ADR 0001). The directive lives as a file in the target
user's own hidden `gilbert` app folder; the server door answers 403 on
every data route until the password changes, and the change clears the
directive itself. The privileged write authenticates as Stalwart's
composite `{target}%{admin}` (impersonation) — it needs Stalwart's
`Impersonate` permission and a password session (app passwords are refused
for impersonation), which the surface states up front.
- **Group label catalog**: an administrator defines the label catalog of a
group mailbox (ADR 0005). The catalog is **the group's** — members apply it —
and it lives in the group's own `gilbert` app folder. The write is made **as
the installation's agent**, which is the principal that reaches a group's own
files (the deployment's credential where there is one, impersonation from the
administrator's session otherwise), so **the requirement is the agent's grant
on the group and not the administrator's own membership**: a group the agent
holds is administered even by an administrator who is not in it, and one it
does not hold answers with the section that asked. Stalwart 0.16 refuses to
mint a session for an impersonated group account (live-verified 2026-09-09),
which is why the door is never the group's own mailbox.
- **What counts as a group** (ADR 0005): an account that answers as a **mail
store**. The session's own list is only a candidate list — Stalwart advertises
the same capabilities on every account it lists, so a folder, calendar or
address-book share that carries an address would otherwise read as a group —
and the one classifier is a probe of the account's mailbox tree, server-side
and in the client alike. A share is never administered or served as a group.
- **Identities and SIP Phone** (ADR 0007), under *Gilbert Mailer* in the
  administration, after *Force passwords*:
  one section, two tabs — **User identities** for a person's, **Group
  identities** for a group's. Each tab picks its principal from a menu that
  lists the accounts the server reports — the empty choice is in it as a real
  entry, so a page can go back to asking which address it is about, and a
  deployment that does not enumerate them falls back to a typed address — and,
  beside it, **Reload identities** re-reads that principal's list and the
  directory from the server — what an administrator reaches for after deleting
  an identity in Stalwart's own administration — leaving an edit in progress
  exactly where it is.
- **User identities** (ADR 0007): an administrator sets a person's
  identities — display name, address, Reply-To, Bcc and signature — from the
  administration, through the **same form** the person's own settings use, so
  an identity means one thing wherever it is written. The write is an
  **impersonation** of that person from the administrator's own session, the
  door forced password changes already use: no new credential, nothing written
  into Stalwart's configuration, and Stalwart's permission model stays the
  whole of the gate. The account's **entire** list is shown and editable — add,
  change, remove, with the server's own `mayDelete` respected so nothing is
  left behind as an identity the administrator cannot see and the composer
  still offers. A **lock** can be applied instead, recorded in that account's
  own Stalwart storage (`identity-lock.json`, its own app folder — ADR 0001,
  not a shared installation-wide list): the person's Identities & signatures
  section is not offered at all. The lock is about **personal mailboxes only** —
  it governs the identities of the account that sends for the person, and
  nothing in a group, where the administration assigns an identity and the
  member reads it whether the lock is set or not. **Enforce** and
  **Release** write and give it back from the page, with no sign-in in
  between — the button reads **Enforced** while it holds, the session at hand
  re-reads its own record at once, and a session already open does so the next
  time it asks, so nobody is signed out over a policy rule. The lock is a rule about
  **this product's surface**, said that way on the surface:
  Stalwart has no per-field permission on an identity, so a client that speaks
  JMAP directly can still write one.
- **The default sending identity** (ADR 0007), on the User identities tab:
  the surface shows which identity an account sends from by default and sets
  it — **Make default** on one, **Default** on the one that holds the place.
  It is not a Stalwart property but one key of that account's own settings
  document, in its app folder, so the administration and the account's own
  Identities & signatures section read and write **one** stored value rather
  than two that can disagree; clearing the choice is a real state, and the
  account then sends with its first identity.
- **Group identities** (ADR 0007), the second tab: a group mailbox holds
  **one identity per member** — the group's own address, carrying each
  member's own display name and signature — so mail sent as the group names
  whoever sent it without a second address. The administration **assigns** a
  member their identity: the fact lives in the group's own app folder, next to
  the identity it names and written in the same action, and it is an
  assignment rather than a display name compared on both sides — a name is
  what a recipient reads, and a binding kept in one breaks on a rename, on a
  spelling and on a name nobody ever set. The tab therefore answers rather
  than guesses: a member's row says what they send as, or says that nothing is
  assigned to them yet and offers to assign one. It reads a member's own
  display name on demand (one impersonation when that row is opened, never the
  whole roster up front) and uses it to prefill the form, so a colleague's
  name is never typed twice. The identities no member is assigned are listed
  beneath the roster, the **group's own among them**: that one is what a member
  with no assignment sends as — the same identity the group's agent sends as —
  so a group nobody has been assigned in still writes as the group rather than
  under somebody's name. The write is always **as the
  Master**: Stalwart refuses to impersonate a group
  mailbox, and the Master is the principal the installation has for acting on
  its groups. Where the Master is not granted on the group, the surface names
  the missing grant rather than showing a permission error; where the roster
  cannot be read, the identities are listed on their own and the surface says
  that no assignment can be made until it reads again.
- **One list, two surfaces** (ADR 0007): the identities a person may send as
  live in the account that **sends for them** — the one their session names
  for submission — and Settings → Identities & signatures reads and writes
  **that** account rather than the mailbox on screen: somebody reading a
  group's mail still edits their own list, and the administration is looking
  at the same objects, so a description cannot differ between the two and an
  identity cannot be missing from one of them. That section reads the list
  when it opens rather than trusting the copy the session read at sign-in,
  and a write from the administration refreshes that copy once the server has
  accepted it: an identity removed there — or in Stalwart's own
  administration — stops being shown here and stops being offered by the
  composer, with no reload and no second sign-in. The same account answers
  every other question of the form "which addresses are mine?" — the domains
  trusted as your own for images, the *me* in a message's recipient summary,
  and the guests of a message made into an event — rather than the mailbox on
  screen, which in a group holds the group's address, or none of yours at all.
  Beneath their own identities
  that section lists, read-only, one block per group mailbox they are a member
  of, saying that the administration sets them and marking **which of them is
  theirs** — the identity assigned to them, or, with none assigned, the words
  that their mail goes out as the group itself. The assignment is the
  administration's and is written from **another** session, so that block reads
  it as it opens rather than trusting what the store holds, exactly as the list
  beside it does: a member who has just been assigned an identity finds out
  here, and one who is told they have none has been read rather than shown a
  stale entry. The administration's User identities tab is the person's own
  account and no other: which group identity is theirs is assigned on the
  **Group identities** tab.
- **What an identity reaches**: mail **composed in Gilbert** — the composer and
  the group's agent go through one signature function. Mail written in another
  client carries that client's own body and signature; there is no server-side
  footer and none is planned (ADR 0007).
- **An identity's Bcc** (ADR 0007): an identity may carry addresses that every
  message sent from it is copied to — a filing address, a ticket system, a
  compliance archive — and it is a field of the identity beside Reply-To, on
  the person's own form and on both administration tabs. The address is written
  into the **Bcc field of the draft** when it is opened, so it is visible to the
  writer and theirs to take off for one message; nothing adds it back at send
  time. It is applied to what the composer opens — a new message, a reply, a
  reply all, a message sent again, and a share — and **not** to a draft reopened
  from Drafts, which is what it was written as. Switching identity swaps the
  address the way it swaps Reply-To, and only while the field still holds what
  the previous identity put there, so an address the writer added stays. RFC
  8621 leaves `Identity.bcc` to the client, which is what this is. Two limits
  are worth stating: it reaches **only** mail composed in Gilbert, so it is not
  an archive of everything the account sends — that is a server-side rule, and
  the system Sieve surface below is where Stalwart's own scripts live; and on an
  **enforced** account it is an address the person cannot take off, which the
  Enforce controls say in as many words.
- **System Sieve** (ADR 0008), under *Stalwart* in the administration: an
  editor for Stalwart's own **trusted, server-wide** Sieve scripts — the
  `x:SieveSystemScript` JMAP registry object, not an account's own filters
  (Settings → Filters & rules). The write runs as the signed-in
  administrator's own session — no impersonation, since the object belongs to
  no account — gated by `requireAdmin` and, on Stalwart's side, permissions
  separate from Gilbert's own admin marker. Stalwart compiles the script on
  save and a bad one comes back as a refusal, not a stored document. Unlike a
  person's own filters, **more than one system script can be active at
  once** — each is invoked by name from Stalwart's own pipeline
  configuration, which this surface does not manage — and two active scripts
  cannot share a case-insensitive name. The source is edited in
  **`SieveEditor`**, the CodeMirror 6 (`@codemirror/legacy-modes`' `mode/sieve`
  grammar) widget this surface shares with the personal "Scripts (advanced)"
  tab, which the same component now backs in place of a plain textarea.
- **A save button offers only a change it would make.** Every save in the
  administration is dimmed until there is something to apply and enabled from
  the moment there is, measured against what the surface last read back from
  the server, so an edit that is applied and one that is still only on screen
  do not look the same. A form that is creating rather than changing — a new
  identity, a new automation — has no earlier copy to measure against, and asks
  instead whether there is enough to create.
- **Nav grouping**: the administration sections are grouped by owner —
Gilbert Mailer (policy, the installation document, forced passwords, group
label catalogs, and **Identities and SIP Phone**, one section with a tab per
kind of principal), Gilbert Assistant (the agent fleet and what it does per
group), server configuration
under “Stalwart” (**System Sieve**, its trusted, server-wide Sieve scripts),
and About ungrouped at the tail.
- **Where the documents live**: policy and settings documents sit in each
account's hidden `gilbert` app folder; the per-user policy layer (values
and enforced flags per user, named profiles, publishing per user or per
group) is the next layer on the same document shape (ADR 0001).

This section is written for the state of 2026-09-13 and is kept current on
every change that touches a feature and on every upstream merge (repo rule:
`AGENTS.md`, "The feature inventory stays current").

---

# Chat

A text conversation per group mailbox — the teams you belong to — owned by
and stored in the group's own account, like its calendars and files (ADR
0005). Offered from a **launcher in the top bar**, first of the action
cluster, only when the session holds group mailboxes.

- **Messages are plain text** — up to 4000 characters — in immutable JSON
documents inside the group account's hidden `gilbert/chat` folder: one node
per message, no attachments, no blob URLs, no HTML (React renders the text;
emoticons are text).
- **Quote replies**: a message — someone else's or your own — can be answered
with a quoted snippet of the original above the reply, WhatsApp-style. The
composer shows the message being answered while the reply is being written;
the reply stores the original's id.
- **Mentions, and who the `@` picker offers**: typing `@` names a member, and
the message records the addresses it named. The list offered is the **group's
roster** — read for the installation as the Master, asked once per
conversation on `/api/agent/group/:name/members` and held for a minute — so
every member is offered, whether or not they have ever written, and somebody
who has left is not. When no roster can be read the participants of the loaded
transcript stand in, which is what the picker offered before there was one. A
mention of somebody the roster no longer lists renders **greyed** in the
transcript: the words are what was written, and the style says the person is
no longer here.
- **Read markers** — `gilbert/chat-state/read-<member>.json`, one per member,
written by that member's own session — make **unread = messages newer than my
marker**. A member who never opened the chat sees badge 0 and the full
transcript; the marker is born at first open. A member added later reads the
conversation from the start, and leaving the group removes access with the
membership.
- **Live**: FileNode state changes ride the same push rail as mail; a
StateChange for a group account runs `FileNode/changes` and fetches the new
documents. When push is down it falls back to the poll with everything else.
- **The whole history is reachable**: the thread opens at the newest messages
and pages older ones in as you scroll up — nothing is silently trimmed, so a
member added later can read the conversation from the start.
- **Search the selected group's messages**: a search in the panel header
scans the group's whole history (loading any not-yet-fetched pages) and
lists the matching messages, newest window first; a result jumps to the
message in the thread.
- **The panel** is a popover under the launcher on desktop (360–400 px,
bubbles: mine right, others left, quote replies on hover) and a sheet in the
content area on mobile — between the top bar and the tab bar, so the menu and
the module tabs stay reachable and the message field sits above the tab bar —
not a sixth tab. It is transient by design: it closes when a composer opens
(a maximised one on desktop, any full-screen one on a phone), and its z-order
sits below the composer dock.
- **V1 boundaries** (ADR 0005): no attachments, no typing indicator, no
presence, no deletion or moderation — growth is append-only; a group that
wants to retire a chat clears the folders through Files.

## The phone, and Global contacts

Gilbert carries its own **Janus** bridge with the SIP plugin — the image carries
it and the release publishes a host tarball the installer fetches, as a second
process beside the app — so a softphone in the client — **gilbertmailer** — and a
**directory** every account
reads arrive with the installation. The telephony server is the deployment's
own, external to the four blocks: Gilbert adds no registrar, no media relay and
no durable telephony state beyond an identity's account (ADR 0023). The
**browser is the phone**: it attaches to the Janus SIP plugin, registers the
account and negotiates the media, and Janus terminates the WebRTC and relays SIP
and RTP. Its signalling is the Janus API, carried over a WebSocket gilbertserver
proxies on its own origin and certificate and authenticates by session. Zadarma
is the reference.

- **One tab holds the line.** The phone is seated by a **Web Lock**: the first
  tab to ask is the phone, every other tab of the same origin shows none, and
  closing, reloading or crashing the holder hands the seat to the next tab,
  which registers then. The registration is the tab's — with no tab holding the
  seat there is no registration, and the provider's own routing takes a call.
- **The line.** One entry in the top bar, beside the chat launcher. Its colour
  is the line: outline when registered and idle, green in a call, red when the
  line is not available — and the red names which leg failed, the browser's to
  Gilbert or Gilbert's to the SIP provider, so a reader is not sent to fix
  their own network for a server's fault. It registers the **identity** it sends
  as — the SIP server, user name and password an administrator sets per
  identity in **Identities and SIP Phone**, account data that follows the
  account.
- **The call.** An incoming call announces itself as a banner; a live call
  **collapses into the top bar** so the reader keeps working. The surface offers
  mute, a DTMF keypad (RFC 2833) and hang up; a second call is refused **486**
  and the provider's routing takes it. A number with no contact can be typed by
  hand, so the phone is not limited to Contacts. One keypad stays in one place
  through every phase — it composes the number, then sends DTMF — and the live
  call takes the dial button's own place, with a small self-updating line naming
  its phase (calling, ringing, connected, busy, no route, …) so a call that
  never lands says why.
- **Audio only, and the same for everyone.** G.711 passed through without
  transcoding, over the provider's own SIP transport (UDP/5060 as built; not
  TLS). The bridge runs its own **STUN-only responder** — no TURN, and no STUN an
  operator names — so the browser gets a server-reflexive candidate. The
  deployment's firewall must leave the bridge's **UDP media range and its STUN
  port open inbound** — the two ports a deployment opens — while the SIP leg to
  the provider is outbound, so 5060/5061 are never opened. What cannot be
  recovered ends cleanly rather than leaving a dead call on screen.
- **Offered only where it can work.** The account must hold a SIP account, the
  bridge must answer, and the media path must be proven before the entry is
  drawn: a deployment whose bridge ports are still closed shows **no phone**,
  and the administration states the bridge's media range as the one thing to
  open.
- **The phone panel** opens attached to the handset in three equal panes: the
  **contacts** on the left, the **dialer** in the centre, the account's **call
  history** on the right. The contacts pane carries two dots with their cause on
  hover, each true in real time and either green or red — the browser's path to
  Gilbert and the account's registration with its SIP server — and tabs
  (**All**, **Global**, **My**, and one row per group the reader belongs to)
  that choose which contacts the list offers, a search with its clear control
  narrowing it live. Only a contact that carries a number is offered,
  and a press dials it; a contact with no number is not a row, and a row names
  the person with the company beside the name where the card carries one.
  Editing belongs to Contacts, so the list is read-only.
- **The call history** is the account's own (`calls.json` in its app folder):
  the calls placed and taken, newest first, each with the direction, the other
  party — or the contact it matches — when it began and the seconds it
  connected. It follows the account between devices and is bounded.
- **Global contacts** is one address book, owned by the Master, shared
  **read-only with every account** and written only by an administrator, from
  inside Contacts. The administrator's write re-applies the share, which is what
  brings an account created later in — the deployment's own share shape is owed
  the live probe ADR 0024 names. Every reader sees it as the first row of the
  Contacts sidebar and merged in `All contacts`; the phone offers its numbers as
  speed dial.
- **No installation-level settings.** There is no SIP Phone administration page
  and no phone section in the installation's document; each person's account is
  per identity. The bridge ships with the release, and the one thing an operator
  opens is its media range — [INSTALL.md](INSTALL.md) has the whole of it.
- **What a browser cannot do**: ring with the tab closed, or keep a call across
  a full reload. Both are the platform's limit rather than a broken promise; with
  no tab holding the seat the provider takes the call, and a reload with a call
  live asks first.

---

# The upstream client

The mail client, calendar, contacts, files, sharing and Sieve editing come from
**upstream**, renamed for this build: this project does not re-document them,
and the reference for installing, configuring or driving them is upstream's own
documentation, whose address is in [NOTICE](NOTICE). The sections below are
kept so this inventory is complete, and they are not the part to read to
understand what Gilbert is.

# Mail

## Layout

Three panes: folder tree, message list, reading pane. Both dividers are
dragged to resize, and both sizes are remembered per device — a width chosen on
a 27" monitor is wrong on a laptop, so they are among the few settings that do
not follow the account. The sidebar's edge takes a double-click to go back to
the width the stylesheet sets, which is also what a reader who never dragged it
has, so their own CSS for it is left alone until they choose otherwise.

- **It reopens where you were.** The mail account on screen, the address book
  and the folder open in Files are remembered per reader and
  restored next time — on this device only, because they are where you were
  sitting rather than a preference, and each one is checked against what still
  exists before a view moves.
- **The reader's own folder tree opens collapsed; a group's opens its folders.**
  The mailbox tree starts shut for the reader's own account — it is theirs, and
  they know its shape — and opens the folders of a group they are a member of,
  whose shape they did not choose and whose folders are the reason they are
  looking: a member added a moment ago sees where the group's mail lives without
  being told to click. A folder opened or closed is remembered as exactly that,
  per reader, beside the place they were left in; a folder is remembered by its
  account as well as its id, so opening one account's folders never opens
  another's.
- **Reading pane** right of the list, below it, or off (messages open full width).
- **Density** comfortable, cozy or compact, which changes row height as well as padding.
- **Font size** small, medium or large.
- **Sidebar** collapsible to icons; a drawer on mobile; dragged by its edge on
desktop, where it is hidden while collapsed (there is no width to choose) and
on a phone (the sidebar is a drawer).
- **Mobile layout** with a bottom tab bar, full-screen composer and full-screen
  reading. Full-screen surfaces measure in `dvh` rather than `vh`, because a
  phone browser's `100vh` is the taller viewport that ignores the address bar —
  a composer sized that way puts Send behind the toolbar. The tab bar, drawer,
  dialogs and compose button all keep clear of the notch and the home
  indicator; `index.html` asks for `viewport-fit=cover`, so the app paints
  under both and the stylesheet is what keeps anything readable out from
  beneath them — the top of the bar included, which is where the status bar
  sits in an installed app. The tab bar is the phone's module switcher, so the
  drawer holds the tree for the section you are in and no second copy of it;
  the top bar carries no signed-in address — the account menu names who is
  signed in — so the search field keeps the width it needs.

### On a touchscreen

Five gestures, every one of them decided by `(pointer: coarse)` rather than by
screen width. The two questions are different and both get asked: a tablet in
landscape is a wide screen that swipes, and a phone plugged into a mouse is a
narrow one that should not. A mouse keeps drag-and-drop onto folders, which
shares the same pointer stream and would otherwise be fighting a swipe for
every drag.

- **Swipe a row** sideways to act on it. Each direction is a setting — right
  archives and left deletes by default, which is what the mail app the phone
  came with already does. Either direction can be set to archive, delete,
  report spam, read/unread, star or move to… — or to nothing, which turns that
  direction off. The coloured strip revealed behind the row names what will
  actually happen *in the folder it is happening in*: "Delete forever" out of
  Deleted Items, "Not spam" inside Junk Mail. Where an action
  is meaningless there — archiving out of the archive, calling your own drafts
  spam — the row will not move that way at all, because a row that slides open
  to reveal a word and then does nothing is worse than one that does not slide.
- **Hold a row** to select it, which is how selection starts on a phone.
  Checkboxes are visible wherever there is no hover, but a checkbox beside an
  avatar is not what a thumb aims at. Once one row is selected, plain taps
  toggle the rest.
- **Hold a folder** in the drawer for the menu its ⋮ button opens.
- **Pull the message list** down to refresh it.
- **Drag in from the left edge** of a conversation to go back to the list.
- **Swipe the calendar sideways** in day or month view to step to the next
  period or back — dragging left pulls the next one in from the right, the way
  paper and every phone do it. Week and agenda scroll through a range rather
  than turning to the next one, so a sideways flick would not obviously mean
  anything there and does nothing. A drag that begins on an event is left
  alone, which keeps dragging an event to move it available to be built later
  without having to be untangled from this first.

  It asks for a longer drag than a row swipe does, and not because the
  consequence is bigger — stepping back undoes it, while a swiped row has
  already been archived. It is because this gesture has no way to change its
  mind: a row slides open as it goes, so the strip underneath names what will
  happen and letting go early calls it off, and a toast offers Undo afterwards.
  Stepping the calendar shows nothing on the way and offers nothing after, so
  the distance is the only chance to not mean it.

The toolbar's refresh button and the thread's back arrow both stay. A gesture
with no visible control is one only the people who already know about it can
use, and none of these announce themselves.

Each threshold crossing taps the vibration motor where there is one, which is
confirmation for the hand rather than the eye — a swipe fires at the moment the
finger passes a line it cannot see. iOS supports none of that and never has, so
it is silently nothing there.

The arithmetic lives in `web/src/lib/touch.ts`, away from the components and
under test, because the numbers are the whole thing. The axis lock is
deliberately biased towards the vertical: scrolling is what a finger on a
message list is doing almost every time, and a scroll misread as a swipe grabs
the list out from under the reader, while a swipe misread as a scroll costs one
more attempt. A drag that is merely more sideways than not stays a scroll.

## The message list

- **Virtualised** — rows are windowed with `@tanstack/react-virtual`, so a
  folder of 100,000 messages scrolls at the same speed as one of ten. Row
  height follows density and the one- or two-line layout.
- **Infinite scroll** with server-side paging, 50 at a time by default.
- **Conversation view** groups a thread into one row, with the thread's own
  message count; it can be switched off to list messages individually — and with
  it off a row is one message: opening one highlights that message alone, the
  reading pane shows it alone, and its id rides in the URL (`?m=`) so a link
  lands on the message it named.
- **Message order** is a setting: newest or oldest first, unread first, starred
  first, largest first, by sender or by subject — or up to three levels of your
  own, chosen in Settings › General. It covers the Inbox alone by default,
  because unread-first is what people want where they triage and confusing in
  Sent, where everything is read; it can be widened to every folder.

  The ordering is done by the **server**, over the whole folder, for the same
  reason search is: a list sorted in the browser is sorted only as far as the
  browser has loaded, which on a folder of ten thousand is the first fifty and
  a lie about the rest. Search keeps newest-first whatever the setting says — a
  result list is already ordered by the question that was asked.

  Every order ends with newest-first as a tiebreak, so rows inside a tie do not
  shuffle between two looks at the same folder.

  **Sorting on a keyword is optional in RFC 8621**, and a server that will not
  do it fails the whole query rather than degrading it — so "unread first" on
  such a server would mean a folder that does not open at all. The refusal is
  caught once, the keyword levels dropped, and the query retried, quietly: the
  reader asked for an order and got the closest the server can give, and a
  toast on every folder change would be the app complaining about its own
  request. `MOCK_NO_KEYWORD_SORT=1` reproduces such a server.
- **Every row says where the message is stored**, in any list that is not a
  folder. A label, a starred view and a search are all questions *about*
  messages, and a row answering one of them says nothing about where the
  message actually lives — so it says it there, beside the labels and quieter
  than them: a label is what the reader filed the message under, a folder is
  where it happens to be, and the folder mark is what tells the two apart. In a
  folder the row is already in the answer, so what it adds is only the *other*
  folders the message also sits in, and a message living in that folder alone
  says nothing. The name is the pickers' own — the interface language's for a
  standard folder, the whole path for a nested one, the last segment on the row
  and the full path on hover.
- **Multi-select** with `x`, shift-click for ranges, `Ctrl/Cmd+A` for all, and
  a long press on a touchscreen.
- **Select the whole folder**, not just the rows that happen to be loaded. The
  header checkbox takes the loaded page, which on a folder of ten thousand is
  fifty of them; a line then offers the other 9,950 by name, and taking it is a
  separate press. A checkbox that silently meant ten thousand when the screen
  shows fifty would be the worst of both, so each option says what it actually
  covers.

  The wider selection is a *query*, not a list of ids: what it reaches is
  resolved from the server when an action runs, walked a page at a time,
  because a folder holds far more than one call returns. It is resolved
  **uncollapsed** — "everything in this folder" means every message rather than
  one per thread. And it is consumed by the action that used it, so the next
  action does not silently reach the whole folder again.

  **Undo is withheld once the selection reaches messages that were never
  loaded.** Undo restores the folders each message was in, which can only be
  known for messages the browser holds; built from the others it would write an
  empty set of folders and leave the message in none at all. Withholding the
  offer is better than restoring something wrong, and the toast simply does not
  carry it.
- **Drag and drop** onto any folder in the tree, moving the selection or the
  row under the cursor.
- **Context menu** on any row: reply, forward, archive, delete, spam, read/unread,
  star, move to…, label…, *Filter messages like this…*, and *Create event…*.
- **Snippets and avatars** are optional; the star is always in the row.
- **Skeleton rows** while a page loads, rather than an empty pane.

### Actions, and Undo

Archive, delete, spam, star, mark read/unread, move and label all offer **Undo**
in the toast that follows, and the undo restores the previous state rather than
guessing at an inverse.

**Archive puts a conversation back where it was filed.** A reply arrives, joins
the thread, and the conversation is back in the Inbox while the rest of it is
still in the folder it was filed under — a case folder beneath Archive, or any
folder the reader made. Archiving it then moves it back there, and only a
conversation that was never filed anywhere goes to Archive itself. The folder is
the one holding the newest filed message, so a conversation that was moved from
one folder to another follows the move; a message already in that folder — the
reader archiving out of the folder itself — is filed away as it always was. It
is one account's own business: a copy of the same conversation in another
account (a group's and the reader's own) is a separate thread there, and is
archived from that account.

**Archive by date** is the explicit version of the same action, and says what it
does: the entries that name a date file into `Archive/<year>` or
`Archive/<year>/<month>`, creating the folders as needed and reusing them after
that — including ones made by hand or by another client. The names are numeric
and zero-padded (`2026`, `2026/09`) rather than month names, because these are
real server-side mailboxes: every other client sees them, a folder created as
"September" by someone reading in English stays "September" for the same account
read in Japanese, and `09` sorts between `08` and `10` where a name does not. The
date is read in the reader's own timezone, so it agrees with the date shown
against the message in the list.

A selection spanning two months is two destinations, not one, and both are
written; the menu names the folder where there is a single answer and describes
the rule where there is not, and the toast afterwards says how many folders it
touched. One Undo puts the whole selection back wherever it came from.

`Delete` moves to the bin. **Empty** destroys, and is offered only on Deleted
Items and Junk Mail — enforced where the action happens, not merely hidden in
the menu. Emptying Junk destroys rather than moving to the bin, because routing
spam through the bin leaves the same problem in another folder. There is no undo
for that one, and the dialog says so.

## Folders

Real JMAP mailboxes, with the server's roles honoured. The sidebar's header
names the account whose tree is on screen — the reader's own address, or a
group's name — so which mailbox is open is never a guess.

- Create, rename, create a subfolder, delete (with or without its mail).
- **Move a folder** by dragging it onto another, or from its menu — *Move to…*
  opens the same searchable picker moving messages uses, with a *Top level* row
  above the folders, which is the only way to move one on a touch screen and the
  quick way in a long list. It lists folders in the order the sidebar lists
  them, each one under its parent, rather than by display path — a folder is
  where the reader has seen it. The picker offers only legal destinations: the
  rights are checked up front (`mayRename` on the folder, `mayCreateChild` on
  the destination) rather than left for the server to refuse one drag. Folders
  with a server role (Inbox, Sent, Drafts, Trash, Junk, Archive) are structural
  and are offered neither, because the server refuses to move them anyway.
- **Subscribe / unsubscribe** — *Show in list* / *Hide from list*. An
  unsubscribed folder still exists and still receives; it is just out of the
  way. Inbox cannot be hidden. **In a group mailbox a member's folders are
  subscribed for them** (ADR 0021): membership is the grant, the mail server
  hands a newly added member the whole tree unsubscribed, and the client writes
  the subscription back for every folder that lacks it as it reads the tree —
  so the group is readable from any other client too. Hiding one is not offered
  in a group, where an unsubscribed folder is not something a member said.
- **A group's tree is drawn whole** (ADR 0021). A tree that is not the reader's
  own shows every folder it holds, subscribed or not — the active account's
  tree and the sections below it answering the same question the same way —
  because the folders of a group arrive unsubscribed. Which tree is whose is
  asked of the session, so it holds from the first frame rather than once the
  account probe has answered.
- **Mark all as read**, optionally including subfolders.
- **Folder colours**, per mailbox id.
- **Unread counts** per folder, live.
- **Storage quota** bar under the tree where the server reports one: it is the
  account on screen — the reader's own, or the group whose mailbox they opened —
  and the server's number for that account's whole disk usage, mail and files
  together.
- **Settings → Folders is about this account's own folders.** A group
  mailbox's folders stay visible in the sidebar and are not listed here, and
  every change made in Settings lands on the reader's own account — a group's
  tree belongs to a different account rather than being extra rows in this one.
- Rights are respected per folder: rename, delete, create-child and share each
  grey out when `myRights` says no.
- **In a group, ending mail is an administrator's decision** (ADR 0015). A group
  mailbox is reached by membership rather than by a share, so the mail server
  tells one member's delete from another's by nothing and offers no rank inside a
  group; the rule is therefore the client's, and it is one module. Everything a
  member does to move mail around still works — filing it in the group's Deleted
  Items, archiving, labelling, replying — and the three things that end a message
  for good are refused: deleting it out of Deleted Items or Junk Mail, emptying
  either folder, and deleting a folder that holds mail. A refused action says so
  and names what still works. It is a rule the product keeps and not a boundary:
  another client on the same account destroys the same mail.
- A folder in the address that this account does not have says *this folder is
  missing*, rather than drawing an empty folder — a stale link should not read
  as a folder that emptied itself.

## Labels

Labels are **IMAP keywords** with a colour and a display name kept in settings.
Because they are keywords, every other client that reads the mailbox sees them,
and they survive Gilbert entirely. A message can carry any number. They are
managed in Settings › Labels, applied from `l` or the context menu, and
optionally listed in the sidebar.

**The list belongs to the account in the foreground.** It sits under that
account's folder tree and before the other accounts' sections, and only the
foreground account has one: the reader's personal labels on their own mailbox,
and a **group's own catalog** on a group's (ADR 0005) — so opening a group
shows that group's labels and nothing of anybody else's, read and counted
through the same rule that decides whose labels they are. The pencil goes only
where the client manages labels; a group's catalog is read from the group's own
app folder rather than edited here.

**A change made by another member shows up live.** A star or a label written in
a group mailbox reaches the other members through the push rail as an `Email`
change on that account, and the counts are re-read when it arrives — so two
people looking at the same group see the same numbers without reloading. A
catalog edited in a group's app folder is a `FileNode` change, and re-reads the
same way.

- **Nesting.** A label can sit under another, and the sidebar indents it.
  Nesting is **display only** — the keywords stay flat on the message, so
  moving a label under another rewrites nothing in the mailbox and a client
  that knows nothing about Gilbert sees exactly what it always did. The parent
  picker will not offer a label's own descendants, so a loop cannot be built;
  and because settings sync between devices, a label whose parent was deleted
  elsewhere comes back to the top level rather than disappearing, while a cycle
  arriving from an older device is broken rather than hung on.
- **How prominent each one is**: always in the sidebar, only while it has
  unread mail, or never. "Only when unread" is the useful one — something filed
  two years ago should not hold a row for ever.
- A label kept by that rule **keeps its ancestors**, whatever they were set to.
  A child cannot be drawn under a parent that is not there, and promoting it to
  the top level would silently rearrange the tree at the moment the reader is
  least able to explain why. The parent comes back as a container instead.
- **The sidebar counts it as unread (all), and Starred leads the list.** Each
  label's row carries *how much of it is new* ahead of how much is filed under
  it — `3 (5)` is three unread out of five, the unread number in bold, and a
  keyword with nothing unread shows its total alone because `0 (5)` says
  nothing `5` does not — and **Starred** sits above them as the first row of
  the same list. It is not
  a label: it is the keyword a star writes, with no colour of a label's to tint
  and no name of its own to rename, drawn by the same row and counted by the
  same read — and drawn with the star it is named after, filled in the star's
  own colour, the way a starred row draws it. The section is there whatever the
  account holds, because an account with no labels still has stars. Clicking
  either opens the messages it counts.
- **The number counts the unit the list will show.** With conversation view on,
  a conversation of three messages carrying a label is **one** — because that
  is the row the reader is about to see — and with it off it is three. The
  count is taken with the same thread-collapsing the list itself uses, so a
  number can never contradict the list it opens.
- **A star, and a label, belong to whatever the row is.** With conversation
  view on, one row *is* the conversation, so starring it stars the conversation
  and labelling it labels the conversation — every message of it that this
  folder holds, never one that reached somewhere else. With conversation view
  off a row is a message, and the star is that message's.

  Inside an open conversation each message keeps its **own** star, which shows
  and changes that one message: a button showing one message's state can only
  write that message, and a control that showed one message while silently
  starring three was the defect this rule removes. The conversation's own star
  is the one at the top of the conversation, which says so.
- **The unread half is kept, and the row leads with it.** A label set to
  "only while unread" is drawn or dropped by how much of it is unread, and the
  row says that number beside the total, so both are asked for — two queries per
  keyword, in one request, because one cannot be derived from the other.
- **The number follows a write.** Starring, unstarring, labelling and
  unlabelling move the count as the **row** changes, not on the next read:
  unstarring a message and watching its count stay put is the kind of lag that
  makes a reader distrust every number on the screen. The row is the unit the
  count itself is taken over, so a write that reaches several messages of one
  conversation moves its number once — by one when the conversation gains or
  loses the keyword, and not at all while another of its messages still carries
  it — and with conversation view off, where a row is a message, it moves once
  per message. Reading a message moves no total — it files it nowhere else —
  and only the unread halves of the keywords it carries. A write that fails puts
  the messages back and re-reads the counts rather than reversing the
  arithmetic.

## Search

The query runs on the **server**, over the whole mailbox, not over the part the
browser happens to have loaded. Gmail operators work as written.

| Operator | Notes |
| --- | --- |
| `from:` `to:` `cc:` | Address or name substring |
| `subject:` `body:` | |
| `has:attachment` | |
| `has:star` `has:flag` `is:starred` `is:flagged` | |
| `is:unread` `is:read` | |
| `in:` `folder:` | By role (`inbox`, `sent`, `spam`, `starred`), then by exact name, then by substring. `in:anywhere` / `in:all` searches everything |
| `label:` `keyword:` | Repeatable; `-label:` excludes |
| `before:` `older:` `older_than:` | |
| `after:` `since:` `newer:` `newer_than:` | |
| `larger:` `size:` `smaller:` | `500k`, `5m`, `2g`, or bare bytes |

Dates parse as `2025-11-22`, `2025/11/22`, `11/22/2025`, anything `Date` accepts,
or relative: `3d`, `2w`, `6m`, `1y`. Quoted phrases hold together, including
inside an operator (`subject:"quarterly report"`). Bare words become full-text
terms. With no `in:`, the search is scoped to the folder being viewed.

An **advanced panel** behind the magnifier offers From, To, Subject, Has the
words, folder, date range, has-attachment and unread-only, and composes the
same query string — so what it builds can be read, edited and learned from.

## Reading a message

- **Sanitised HTML**, rendered inside a **Shadow DOM** so the sender's CSS
  cannot reach the app. DOMPurify strips scripts, event handlers, forms and
  anything that could navigate the top window.
- **Plain-text mail keeps its shape.** A message with no HTML goes into the
  reader as the text it is — the sender's line breaks kept, a step per level of
  quoting and the quoted block collapsible — rather than run together into one
  paragraph. The rules are in `EMAIL_BASE_CSS` (`web/src/lib/html.ts`).
- **Remote images load by default.** *Always show* is what Gilbert ships with,
  so a message arrives drawn the way the sender made it; a reader who would
  rather approve each one switches to *Ask before showing* in *Privacy &
  safety*. The policy is one of ask, automatic for people in your contacts, or
  always. When the policy asks, a banner offers *Show images* or *Always from
  this sender*, and the per-sender allow-list lives in settings and so follows
  the account.
- **Privacy image proxy** (on by default): approved remote images are fetched by
  Gilbert's server, so the sender learns nothing about the reader — no IP
  address, no user agent, no read time. With the proxy off, images load
  directly and the sender learns all three; the docs say so plainly.
- **Inline images** (`cid:`) are resolved against the message's own parts.
- **Attachments** listed with type and size: download, open in a new tab, and an
  inline preview for images and PDFs. **Download all** takes the lot, and
  **Download all to Files** keeps them in the account instead — asking first
  whose files, then **which folder inside them**, for the reader's own files or
  for a group's, where every member of the group finds them (a node created in
  the group's account is the group's from creation). The folder list is read
  from the destination account and a folder can be made there, and the walk is
  rooted at the top level of the account chosen rather than at wherever Files
  happens to be looking. The blobs are copied into the chosen account, because a
  file node can only point at a blob its own account holds. Offered for one
  attachment as much as for a set: a single file is the commonest thing to want
  kept rather than downloaded.
- **Show original**, **Show headers**, **Download (.eml)** and **Print**.
- **`winmail.dat` opens.** Outlook sending in Rich Text packs every attachment
  into one TNEF blob that most clients cannot read, so the files inside are
  gone as far as the reader is concerned. A banner offers to open it and the
  contents appear as ordinary attachments, named and typed. The long filename
  is read out of the MAPI stream where there is one, so a file that arrived as
  `Quarterly Report Final.docx` is not called `QUARTE~1.DOC`.

  It is decoded **in the browser, on request**: the server never sees the
  contents and has nowhere to keep a decoded copy, and doing the work on sight
  would spend the bandwidth whether or not anyone wanted what is inside. A blob
  that goes wrong part-way through keeps the files read before that point —
  half of them beats none — and the original stays attached either way.

  The message body is deliberately not decoded. TNEF can also carry it as
  compressed RTF, which is a second format again for a body the reader already
  has in plain text or HTML nine times in ten.
- **Forward as attachment** sends the message itself rather than a quotation of
  it — headers, structure and every attachment intact, which is what a bounce
  or a phishing report needs and what quoting destroys. It costs **no upload at
  all**: a message's `blobId` is its own RFC822 blob and already lives in the
  account, so a 40 MB message attaches by reference as fast as a small one. In
  the message's ⋮ menu, the list's right-click menu, and the overflow on the
  reply strip at the foot of a thread, which is the one a thumb finds on a
  phone.
- Saved and attached `.eml` files are **named from the subject in whatever
  script it is written in**. The rule keeps letters and drops only what a
  filesystem cannot take — path separators, the names Windows reserves, control
  characters — so a Russian or Japanese subject keeps its own name instead of
  becoming a row of underscores.
- **Unsubscribe** where the message carries `List-Unsubscribe`.
- **Sender details** expand to the full From/To/Cc/Reply-To with addresses.
- **What the spam filter said** sits in those details, read back off the
  message rather than scored here: the verdict, the score, the threshold it was
  measured against, and the rules that moved it, largest mover first and signed
  so which way each pushed is visible. Both the SpamAssassin-shaped `X-Spam-*`
  set that Stalwart's own filter writes and Rspamd's `X-Spamd-Result` are read;
  anything else is left alone rather than guessed at. Two things it will not
  do: a score is always given the threshold it was measured against, because
  6.7 is damning against 5 and unremarkable against 15 and the number alone is
  not something a reader can act on — where no threshold was stated, it says
  so; and where the filter recorded no verdict, none is invented from the score,
  since the filter applies policy Gilbert cannot see. Mail that arrived without
  these headers shows nothing.
- **Message body theming** is off by default — sender HTML is left exactly as it
  was designed, on a light card. One setting lets mail that brings no colours of
  its own follow the app's theme instead. That is a low bar in practice: one
  `color:#FFFFFF` on one button label opts a whole message out, so for mail
  built from a template it changed nothing. A second setting, off unless the
  first is on, forces the theme over the sender's own colours. It tells a
  *sheet* the design sits on, like a white wrapper table, from a *painted
  surface* like a button or a banner, by relative luminance: the first is
  neutralised so the bright card goes away, the second is kept whole so its
  label stays readable on it. Nothing the sender wrote is removed, so the
  switch is reversible, and print is unaffected either way.

### Conversations

- With conversation view on, a conversation opens on its **first unread
  message**, not the newest, so unread mail is never above the fold with only
  a marker to hint at it.
- The opening scroll is held until the thread settles, so the reading position
  does not jump as messages measure themselves.
- `n` / `p` move between messages in the thread; `]` archives and opens the
  next conversation.
- **Auto-advance** after archive or delete: back to the list (default), or on to
  the next or previous conversation.
- **Mark as read** immediately, after 2s, after 5s, or never automatically.

### Cards inside a message

- **Invitations (iTIP)** render an invite card: what, when, where, the guest
  list with each person's status, and Yes / Maybe / No. The reply is written to
  the event and sent back to the organiser. Cancellations are recognised too.
- **vCard attachments** render a card offering to add the person to an address
  book.
- **Right-click anyone named** in the message — From, To, Cc, Bcc or Reply-To —
  to add them to contacts with the editor prefilled and the display name split
  into first and last, edit them if already known, write to them, or copy the
  address.

### Read receipts (MDN, RFC 8098)

Stalwart does not implement JMAP's `MDN/send`, so Gilbert assembles the
`multipart/report` itself, uploads it, imports it and submits it like any other
message — which is why a sent receipt lands in Sent.

Nothing is ever sent automatically, and there is deliberately **no "always"
setting**: a receipt confirms to whoever asked that the address is live and when
it was read, to an address of their choosing. The rules:

- Bulk mail, mailing lists and anything marked `Auto-Submitted` are not offered
  a receipt at all.
- A receipt aimed somewhere other than the sender says so before it is sent.
- Sending is recorded with `$mdnsent`, so a second look — or another client —
  knows not to ask again.
- The setting offers *ask me each time* or *never*.

Requesting one on your own outgoing mail is a separate switch.

## Composing

**Multiple composers at once**, floating in a dock at the bottom right, each
minimisable and maximisable; full-screen on mobile.

- **Rich text**: bold, italic, underline, strikethrough, text colour, highlight,
  font size, alignment, bulleted and numbered lists, indent/outdent, blockquote,
  code block, links (`Ctrl+K`), inline images, an emoji picker, and remove
  formatting. Tab and Shift+Tab indent inside the body.
- **Plain text** as a per-message or default format.
- **Recipient chips** with autocomplete from contacts, shared address books you
  have added, the server directory and recent recipients; your own cards win a
  tie against a colleague's copy of the same person. Free-form addresses parse
  leniently (`Ann <ann@x>, bob@y; "C, D" <c@z>`). A **group** is offered with
  them, marked as a group with the number of people in it, and taking it adds
  those people — one address per member, the preferred one — with a note when
  a member had no address to add (ADR 0004).
- **Recipient picker** — the contacts button beside Cc/Bcc, or the To label —
  opens the address books to search across every book or one, tick as many
  people as needed and send them to To, Cc or Bcc. Every address gets its own
  row, so somebody with a work address and a personal one is a choice — and a
  group gets a row of its own, marked with its size, which sends its members.
- **Cc, Bcc and Reply-To** revealed as needed. An identity's own Bcc arrives
  already in the Bcc field, visible and removable for one message.
- **Priority**.
- **Identities**: multiple From addresses, a per-account default that Gilbert
  keeps (JMAP has no such flag), and hiding identities from the picker without
  deleting them — an account with alias domains can have every local part twice
  over while only a handful are ever used. In a **group mailbox** the picker
  offers the identity the administration **assigned** to the reader, and the
  group's own behind it (ADR 0007): one identity per member, so a member sends
  as themselves — never under another member's name — and a member nothing has
  been assigned yet sends as the group itself rather than being left with no
  sender. The composer says so in as many words only when the group holds no
  identity at all, which is the one state where there is nothing to send as.
- **Signatures** in HTML per identity, inserted above or below the quote.
  Stalwart caps an identity signature at 2047 **bytes** of UTF-8, so Gilbert
  compacts the HTML, and where it still will not fit, stores the full signature
  in the account's Files and leaves a marker plus a plain-text fallback in the
  identity. Signature images live in Files too and are turned into inline
  `cid:` parts when the message is sent.
- **Templates**: named subject + body, inserted into any draft, managed in
  Settings. Both carry **placeholders** — `{{recipientName}}`,
  `{{recipientFirstName}}`, `{{recipientEmail}}`, `{{myName}}`, `{{myEmail}}`,
  `{{subject}}`, `{{date}}` and `{{time}}` — filled at the moment the template
  is inserted, so what they came to is visible and editable before anything is
  sent rather than changing under the message afterwards. Dates and times
  follow the same format settings as the rest of the app. A placeholder that
  cannot be answered yet — a recipient's name on a draft nobody has addressed —
  is **left in the body exactly as written**, because substituting an empty
  string there produces "Hi ,", a greeting that is wrong rather than one that
  is visibly unfinished. A name that is not a placeholder is left alone too.
- **Attachments** by picking or dragging onto the composer, with progress per
  file and the size limit the server states (`MAX_UPLOAD_BYTES`, 50 MB by
  default). A pasted image is inserted inline instead, and pasted HTML is
  sanitised on the way in.
- **Attach from Files** — anything the server already holds attaches with **no
  upload at all**, however large. A file from someone else's shared folder is
  copied to your account first, because a message can only carry blobs from the
  account sending it; the picker says so before it does. Your **groups' files**
  are listed alongside your own — membership of the group is the grant, so
  nothing needs per-user sharing first.

  The upload limit applies to that copy and to nothing else. `maxSizeUpload` is
  what the server will accept for a single *upload*, so it bears only on a file
  that is about to be uploaded — a blob this account already holds is attached
  by reference and never sent. Checking it in both cases refused a 60 MB message
  the server was already storing, on the grounds that it could not have been
  uploaded, which it was not being.
- **Attachment reminder** when the text mentions an attachment and none is there.
- **Spell check** toggle.
- **Drafts** save as you type and on close, with the save state shown.
- **Quoting** on reply, with the signature placed above or below it. One reply
  reaches **one partner** and Reply all reaches **everyone** — the difference the
  reader sees in the draft, since reply all is the action that puts a list there.
  The one-button affordances (a message's own header, the reply strip at the foot
  of a thread) reach **everyone**, which is what the app does rather than a
  preference; every menu offers both actions, each saying which it is, and the
  keys are the plain pair — `r` answers the sender, `a` answers the list.
- **Compose as new** — the same mail again rather than passed on, for one that
  bounced or went to a misspelled address. Recipients, Reply-To, subject, body
  and attachments come across as they stand; the Message-ID, date and threading
  headers do not, so it sends as a mail that has never been sent, and the
  original is neither altered nor marked. In a message's own menu, in the list's
  right-click menu, and behind the overflow on the reply strip at the foot of a
  thread — which is the one a thumb finds on a phone.
- **Send and archive**, and **archive on reply**, as options.

### Undo send, and scheduled send

Two different mechanisms, deliberately.

**Undo send** holds the message in the browser for 0/5/10/15/30 seconds (10 by
default) and shows a toast naming the mail, with a way back. Nothing has been
submitted yet.

**Scheduled send** hands the message to *Stalwart's* queue. JMAP has no
client-settable `sendAt` — RFC 8621 makes it server-derived — so the hold is
requested through SMTP FUTURERELEASE (RFC 4865) as a `HOLDUNTIL` parameter on
the envelope, and the server reports back the `sendAt` it settled on. It goes
out whether or not Gilbert is open, or ever opened again.

Held messages wait in a **Scheduled** folder Gilbert maintains itself (JMAP has
no role for one), and reconciles when you next open it: released messages move
to Sent, cancelled ones back to Drafts. The picker offers presets and an exact
date and time, bounded by the maximum delay the server advertises.

> If Stalwart's `futureRelease` is not configured, a "scheduled" message is sent
> **immediately**, with no error and no sign the hold was dropped. Gilbert only
> offers the feature when the account advertises the capability, and the mock
> has a switch (`MOCK_NO_FUTURE_RELEASE=1`) that advertises it and then drops
> every hold, so the failure can be developed against.

---

# Calendar

JMAP Calendars and JSCalendar (RFC 8984), with Stalwart's vocabulary where it
differs from the RFC.

## Views

Month, week, day and agenda, each addressable by URL (`/calendar/week/2026-08-30`).
A mini calendar for jumping, *Today*, and next/previous by keyboard (`n`/`p`) or
button. The default view, week start, working hours and default event duration
are settings.

## Calendars

The sidebar keeps the panes apart:

- **My calendars** — yours, each with a colour, each hideable with a click.
- **Group calendars** — one subsection per group mailbox (freight@…, the teams
  you belong to): that group's calendars, and a **+** that creates a calendar
  **owned by the group** — the create goes to the group's own account, so every
  member sees it, a member added later included, with no share to maintain. A
  group's calendars need no adding — membership is the subscription, so no
  "available" row is drawn for them — and a group calendar's **colour belongs to
  the calendar**: every member sees the same one, and only an installation
  administrator may change it.
- **Shared with me** — other people's, once added.
- **Available to add** — shared with you but not yet added, with a plus beside
  each. An unadded calendar draws nothing. This is deliberate: the server
  reports every collection in an account you can reach, whether or not anyone
  meant to share it, so being handed one is not evidence that it was offered.

Right-click your own to rename, recolour, share, stop sharing or delete;
right-click a group calendar to remove it from your view (editing it is the
administrator's, above); right-click one of someone else's to remove it from
your view, which changes nothing for anybody else.

- **iCal import** through `CalendarEvent/parse` (a file of any number of
  events), from the calendar's own menu, into that calendar. The events are
  filed rather than scheduled: no invitations go out to anyone named in them.
- **Re-importing updates rather than duplicates**, as a contacts import does.
  An event is recognised by its UID, per calendar, and what the file carries
  wins -- so a corrected export corrects what the first attempt got wrong.

  Two things are deliberately left alone: **who accepted**, and **edits to a
  single occurrence**. Both are answers and decisions taken here after the file
  was written, and a file that mentions them at all describes them as they were
  at export, so writing either one over would throw away work silently and
  return no error anywhere. A corrected export therefore fixes the time, the
  title and the location, and leaves the RSVPs and the "just this Wednesday"
  changes where they are.

  The cost runs both ways and is worth knowing. An attendee added at the source
  since the last import does not arrive, because nothing here can tell that
  apart from an answer given in Gilbert. And an import still sends no
  scheduling messages, so an event a re-import moves is moved *here* --
  everybody else's copy still says the old time until whoever is organising
  sends the update from the event itself.
- **Subscribed calendars** by URL — a timetable, a rota, a public holiday list.
  Added in Settings › Calendar & contacts, read-only, and shown beside your own
  with their own colour.

  **Nothing is stored.** The document is fetched when you open the calendar and
  parsed in the browser; the server keeps no copy, no cache and no schedule,
  which is what lets an immutable container serve this at all. There is no
  timer either: Gilbert has nowhere to run one, so the honest guarantee is
  that a subscription is as current as the last time somebody looked — which is
  also when it matters.

  The fetch has to happen on the server, because a calendar URL belongs to
  whoever published it and almost none of them send CORS headers. That makes it
  the second place Gilbert reaches an address a stranger chose, and it goes
  through **exactly the same guard as the image proxy** — one implementation,
  not two: the name is resolved and every answer must be acceptable, the
  connection is pinned to the address that was checked, and each redirect is
  re-resolved and re-pinned. `webcal:` is understood, because that is how these
  are published, and it is read as `https:` rather than waved past the checks.

  Two consequences worth stating. A calendar on a private address — including
  one on your own machine — is refused, by design. And **recurring events are
  not expanded**: `RRULE` is a small language with a lot of edge cases, and a
  subscription quietly showing the wrong dates would be worse than one showing
  the first occurrence.

  A subscription that cannot be read **says so** in the sidebar rather than
  drawing an empty calendar, which looks like a calendar with nothing in it.
- **Birthdays**, as a calendar of its own derived from the birthdays already on
  your contacts. Off until switched on in Settings › Calendar & contacts, and
  hideable from the calendar's own sidebar without turning it off.

  **Nothing is written anywhere.** The dates live on the cards; a second copy
  of the same fact would drift the first time somebody corrected one, and
  keeping a calendar of its own is exactly what Gilbert does not do. An entry
  disappears when the contact does, or when the birthday is cleared.

  They cannot be edited or deleted, and that falls out of the design rather
  than being special-cased: the virtual calendar reports no write rights, so
  every control that asks before offering Edit or Delete already declines. The
  store refuses a synthesised id as well, whatever calls it.

  A card that records only a day and month — the common case — gets a birthday
  with no age rather than no birthday. And 29 February falls on the 28th in a
  year that has no 29th: somebody born in February has a birthday in February,
  and moving it into March is the arithmetic winning over the fact.

## Events

Created by clicking an empty slot or dragging across a range; a context menu on
empty space offers a timed or all-day event at that moment, or *Go to day* /
*Go to week*. Also from a message — see *Create event…* below.

The editor covers title, start and end (all-day or timed, with a time zone),
calendar, location, meeting link, guests, description, reminders, repeat,
status (confirmed / tentative / cancelled), show-as (busy / free), visibility
(default / private / secret), category and colour.

- **Recurrence** — none, daily, weekly, weekdays, monthly, yearly, or a custom
  builder: interval, by-weekday, by-month-day, and an end by count or by date.
- **Reminders** — one or more alerts before the start, with a default in settings.
- **Colour categories**, Outlook-style: named colours managed in Settings ›
  Calendar, assigned from the editor or the context menu, and stored as
  JSCalendar `categories` so other clients see them. (The per-event colour
  picker that predated them is gone; a colour comes from the category, or the
  calendar.)
- **Duplicate** an event from the context menu.
- **Create event…** from a message, in its context menu and its ⋮ menu (and,
  on a phone, in the ⋮ of a held row). The subject becomes the title and the
  body the description; the sender and everyone the message was addressed to
  become guests, minus your own addresses and never a blind copy. The editor
  opens on the next half hour for an hour, because when it happens is the one
  thing the message cannot say — and with *Send invitation emails* off, since
  a guest list you inherited rather than typed should not mail itself on the
  first press.
- **Popover** on click with the detail and quick actions; the editor on
  *Edit…*.

## Attendees, invitations and free/busy

Invitations go out as iTIP when guests are added, replies come back and are
applied to the event, and cancelling notifies the guests. Guests are added by
name or address with the same autocomplete the composer uses.

Where the server implements `Principal/getAvailability`, the event editor grows
a **scheduling panel**: a row per participant — you first, because scheduling
around everybody except yourself is how two things end up at the same time —
over the days the event spans, marked by the hour or by the day depending on how
wide that is.

- **It is somewhere to put the event, not only something to read.** The pointer
  shows the half hour it is over, and clicking moves the event there keeping its
  length.
- **It steps backwards and forwards** a screenful at a time without touching the
  event, and offers its way back. Clicking while stepped away moves the event to
  where you clicked and brings the view with it.
- **A week is as far as it stretches.** Something running longer is not an event
  anybody is hunting a free slot in; it says how many days it left out instead.

**Whoever cannot be read is drawn hatched, never blank.** Free/busy is answered
per principal, and only accounts on this server are principals — so for a guest
at another domain there is nothing to read. Leaving them out is the one
presentation that lies: a row with nothing in it reads as a diary with nothing
in it. A line under the grid says how many and why.

That limit is the protocol's rather than a gap waiting to be closed. A
`Principal` exposes no route to its calendars at all, so free/busy is not the
weaker permission — it is the only channel between two accounts, and it needs no
sharing to be set up first.

## Recurring events: series and single occurrence

Editing or deleting a recurring event asks which it applies to, and both
answers work: the **whole series**, or **this occurrence only** (written as a
`recurrenceOverrides` entry).

Two things about that are worth stating, because they are the reason it took
work:

- **Not everything can differ per occurrence.** 0.16.20 sorts properties into
  three groups, and only one is honest: some are *rejected* loudly; some are
  *inherited* — dropped from the patch while the response still reports
  success; the rest are applied. Gilbert checks the patch before sending it, so
  a rejected property is an error you can see and an inherited one is reported
  as something it could not do for one date, rather than claimed as saved.
- **Occurrence ids became stable in 0.16.21, and were not before it.** Through
  0.16.20 Stalwart's synthetic ids encoded a *position* in the expanded series,
  so writing one override renumbered the rest and the same five ids addressed a
  different five dates. 0.16.21 identifies an occurrence by its recurrence id
  instead — confirmed live on 0.16.21 (2026-09-06): a five-week series was
  expanded, its third occurrence retitled through its own synthetic id, and all
  five original ids re-read afterwards still named their own dates. Gilbert
  re-resolves an occurrence from its `recurrenceId` immediately before touching
  it anyway. That is no longer load-bearing on the current server, and it stays
  because it costs one lookup, because a vanished date still has to say so
  rather than be acted on, and because the client supports 0.16 as a whole
  rather than only its newest release.

*This and future* is not offered: the server refuses an occurrence that belongs
to such a change, and where it does, Gilbert says so and offers the series.

**Events are dragged.** In the day and week grids an event moves by dragging
it and changes length by dragging its bottom edge, both snapping to fifteen
minutes; in the month grid it moves to another day and keeps the time it had.
The editor is still there and still does everything a drag cannot.

- **A recurring event asks which dates it means**, the same question the menu
  asks, and goes through the same path — so a date the server will only change
  as part of a whole series offers that rather than failing.
- **Only where it can be saved.** A read-only calendar offers no drag, and
  neither does a birthday: it is derived from a contact and there is nothing on
  the server to move.
- **Invitations are not sent.** A drag is a scheduling gesture, and mailing
  every guest on each nudge of a block is not what the hand was asking for. A
  change that should go out with notice goes through the editor.
- The new time is worked out **in the event's own frame** rather than through
  an instant: its stored wall clock is what moves, and its time zone is not
  touched. A move in the month grid shifts it by the number of days the hand
  moved it, rather than writing the date it was dropped on — those are the same
  thing only while the event's zone is the reader's. An event kept in Tokyo and
  read from Phoenix is drawn on the previous evening, so writing the dropped-on
  date sent it a day earlier than the pointer went. Computing a new time from the reader's local hours and then
  re-expressing it in the event's zone converts twice, and the two do not
  cancel.

---

# Contacts

JMAP Contacts and JSContact.

- **The list is resized by its edge**, dragged between a floor that keeps a
  name and an address legible and a ceiling that always leaves the contact its
  own width, with a double-click back to the default. Its width is remembered
  per device, beside the mail list's, for the same reason. The divider is hidden
  where a narrow screen shows one pane at a time.
- **Address books**: the **Contacts** list leads with **Global contacts**, then
  **All contacts**, then the reader's own under **My contacts**; a **Group
  contacts** section gives each group mailbox you belong to its own subsection —
  its books, and a **+** that creates a book **owned by the group** in the
  group's own account — and other people's are plainly separate under **Shared
  with me**, with the same *Available to add* split the calendar uses. Create,
  rename, share, stop sharing, delete; one is the default for new cards.
- **Contact records**: photo, prefix, first, middle, last, suffix, nickname,
  company, job title, any number of emails, phones and addresses with types,
  birthday, website and notes.
- **Groups** as a card kind, with members picked from the book the card is
  filed in — the group's own cards when the group's directory is the target,
  since a member is named by a `uid` that means nothing outside its account.
  A group is a set of people rather than a person, so its entry has no email,
  phone, post, dates or links: those fields are not offered for it and not
  written, wherever it is filed. **Every row says which kind it is, without a
  word wherever a word is not needed**: a group's name is set **bold**, a
  person's carries the **company** they belong to beside it, and an
  organisation is the one that still says so — *· organization* — because its
  own name is the company and nothing else on the row would tell the two apart.
  A card with no person name of its own is shown as its company, and says it
  once. **Email group** on a group's own page addresses
  its members through the one resolution the composer uses (ADR 0004).
- **All contacts holds every group's contacts as well as your own.** A group
  mailbox's books need nobody to add them — membership of the group is the
  subscription, the same rule the composer's suggestions follow — so the one
  list of everything is the reader's own cards **and** the cards of every group
  they belong to, with **the group named on the row** that came from one, small
  and at its end. A colleague's shared book is not a group's and stays out: that
  one is added deliberately and lives under *Shared with me* in the sidebar. **A row
  is opened by its account and its id** — ids are minted per account, so the
  reader's own card and a group's can carry the same one, and the account is what
  tells them apart: it travels in the row's address, in the tick on it, and in
  the book a card's Edit and Delete are offered for.
- **Select and delete in bulk** — tick rows in the list, shift-click for a run,
  and delete the lot; or **Empty address book** from the book's own menu, which
  is the operation a migration asks for when an import needs doing again. A card
  filed in two books is only ever removed from the one being emptied, since
  deleting it would empty a book nobody asked about, and what is reported
  afterwards is what the server confirmed rather than what was asked for. A
  selection may span accounts — *All contacts* holds your own cards and every
  group's — so each account is asked for the cards it holds and the count is
  what the server confirmed across them.
- **Letter index** down the list, with `#` for everything that does not start
  with a letter.
- **Search** across name, address, organisation and notes, in one book or all.
- **vCard import** through `ContactCard/parse` (a file of any number of cards),
  and **export** of one card, a whole book, or **everything** as `.vcf` —
  *Export all contacts* being what the *All contacts* list holds, the groups
  included.
- **LDIF import**, for address books coming from SOGo, Thunderbird or an LDAP
  directory. Nothing on the server reads LDIF, so the file is read here:
  RFC 2849 for the syntax, [Mozilla's address book schema][ldif-schema] for what
  the attributes mean, which is the one such exports almost always use. Work and
  home addresses, every phone kind, second email, organisation and units, job
  title, nickname, web pages and the custom fields all come across. The import
  control takes either format and decides by what is in the file, not by what it
  is called.
- **Re-importing updates rather than duplicates.** A vCard is recognised by its
  UID; an LDIF entry, whose schema has none, by its distinguished name. The card
  already here is merged with the file's version -- what the file carries wins,
  what it does not mention is left alone -- so a corrected export can correct
  what the first attempt got wrong. Matching is per address book, which is also
  how two directories that each hold a `cn=John Smith` stay two people. An entry
  no longer recognisable, because its `dn` moved between exports, is imported
  again and counted: *"3 of them look like contacts you already had."*

[ldif-schema]: https://wiki.mozilla.org/MailNews:Mozilla_LDAP_Address_Book_Schema
- **Directory lookup** through `Principal/query`, so colleagues on the server
  can be addressed without being in an address book first.
- **Recent recipients**, kept on the device — and only on a device you said was
  yours.
- Contacts in a shared book you have added — or in any book of a group you
  belong to — are offered when addressing a message exactly like your own; your
  own card wins a tie. A group's books need no per-member adding: membership is
  the subscription, the same rule Files follows for a group's folders. Shared
  cards load by page up to **5 000** per account — beyond a working group's
  needs while still bounded.
- **A group's contacts are the group's to work with.** Edit and Delete are
  offered on a card in a group mailbox's address book to the members of that
  group, because the book grants the write — the client asks the book holding
  the card, not whose account the card is in, which is what took the controls
  away from the people a group's directory exists for. The book itself is
  named by whoever may write it too (Rename on the group's own directory), and
  the write goes to the account that holds it. A colleague's read-only share is
  still read-only, and says so.
- **Moving a contact between accounts is an administrator's** (ADR 0018). A card
  lives in one account, and a group's card is the group's, so moving one from a
  personal book into a group's — or back out, or from one group to another —
  changes whose it is: a right-click on the row offers **Move to…** to an
  installation administrator only, and the dialog names each group and the books
  it owns. Filing a **new** contact into a group's book, editing one where it
  lives and re-filing a card between two books of the same account are not moves
  and are unchanged — a member does all three. The editor's address-book picker
  follows the same rule: a new contact may be filed into any book you can write,
  an existing one is offered no account that would be refused. It is a rule this
  client keeps, not a boundary: another JMAP client moves the same card.

---

# Files

JMAP `FileNode`, in the shape 0.16 defines (`nodeType`, four separate rights).

- **Folder tree** in the left pane, fetched **in one request**, so opening a
  folder never waits on a round trip.
- **Collapsed by default, and remembered per reader.** The tree starts shut —
  a group's or a shared account's folders as much as the reader's own — and the
  folders that were opened come back next time, beside the rest of where the
  reader was left. Each open folder is named by its account and its id, because
  node ids are unique per account and an id alone would open another account's
  folder.
- Browse, download, create folders, rename, move, delete.
- **Sorted by a clicked column, and each folder keeps its own order.** Clicking
  **Name**, **Size** or **Modified** orders the listing by it, and clicking the
  column already in force turns it around — two states and no third, because a
  listing is always in some order. The sorted column's name is **bold** with a
  small arrow for the direction, the other two are plain names you can click.
  **Folders come first whatever the column** (a folder has no size), and within
  each group the column decides with the name breaking ties, so two devices draw
  the same order. The order is remembered **per folder** on this device, beside
  where the reader was left, and applies to what the browser holds: a folder is
  read whole (up to the store's own read ceiling) rather than a page at a time,
  so it is sorted in the browser rather than asked of the server.
- **Multi-select with checkboxes.** Every row carries one, with a select-all in
  the header (indeterminate while only some rows are ticked), and the selection
  is acted on from the bar that counts it: **download its files**, **move**,
  **merge folders** and **delete** — the same actions the row menu offers when a
  whole selection is opened through one of its rows. A folder has no bytes to
  download, so the action names how many *files* it will put on disk. Shift-click
  takes the run from the last row clicked, ctrl/cmd-click adds or removes one,
  and the selection is dropped when the folder changes. The bar itself is
  **always on screen**, counting *0 items selected* when nothing is ticked, so
  the listing does not move under the pointer the moment the first box is
  ticked; what changes with the count is what can be done, not what is drawn.
- **Open a folder by double-clicking it.** A single click on a row selects it,
  the name included — the name is a label, not a door — and the double click
  opens a folder or previews a file. In the sidebar tree a single click goes to
  the folder and a **double click opens or shuts its branch**, the way a file
  manager's tree behaves, with the twisty doing the same thing in one click.
- **Merge two folders into one.** Ticking exactly two folders makes **Merge
  folders…** usable — with one, three or anything that is not a folder the entry
  is there and greyed, because two is the number the feature is defined for —
  and it asks once which of the two **names stays**. That name's folder is the
  one that survives, and everything the other holds moves into it: a subfolder
  that is in both is merged into one (deeper names by the same rules), a **file**
  whose name is in both has the other one's bytes written into the node that
  already holds it — same id, same sharing, same place in the tree — and the
  file the bytes came from is destroyed, so one file of that name is left. The
  folder given up is destroyed last, once it is empty. The whole thing is
  **decided before anything is written**: both trees are read first, and a name
  that is a folder on one side and a file on the other — or a right the reader
  does not have — stops the merge with nothing created, moved, copied or
  deleted. The dialog closes as the merge is asked for — the question is
  answered, and waiting would hold the reader in it for the whole run — and the
  merge runs in the tray like an upload: *"2 of 7 items"* beside **Cancel**,
  which stops the run and leaves whatever it had already done done.
  A merge that is stopped or fails therefore leaves both folders in place, with
  what had moved already inside the kept one, and can be asked for again
  (ADR 0014).
- **Drag a row** onto a folder in the list or anywhere in the tree to move it.
  A folder cannot be dropped inside itself.
- **Drag from the desktop** to upload — and drag a *folder* to upload it with
  its structure intact, subfolders created as needed, **empty folders
  included**. (The structure is only reachable through `webkitGetAsEntry`,
  whose entries go stale the moment the drop handler returns, so the tree is
  read out synchronously and walked afterwards.)
- **Dropping a folder that is already there adds to it** rather than making a
  second one beside it: the folders of the drop are resolved first, a folder
  the target already holds is used as it is, and only what is missing is
  created. A **file** whose name the folder already holds is **written over**,
  in place: the node that carried the name is the node that holds the bytes
  now, so its id, its sharing and its place in the tree stay and only the
  content changes. Dropping the same tree twice is therefore one tree holding
  the latest bytes — never a second copy beside the first, and never a page of
  errors (ADR 0013). What a file may not write over is a **folder** of its
  name: nothing is renamed, destroyed or put beside it, and the file is
  reported on top instead. A folder the drop could not be created — a file is
  standing where it goes — stops with its whole subtree reported rather than
  filing those files into whatever folder does exist.
- **A drop resolves its tree in one request.** The account is read once and the
  whole walk answers from that, however deep the folder is; an account larger
  than one read of it (a thousand nodes) is finished by reading the levels it
  has to — the folder that was past the page is looked up when the server
  refuses the create — not by paging the account. What that read is **for** is
  folders: a file's name is answered by the create itself, which names the node
  holding it wherever in the account it sits, so a name the read never reached
  is written over all the same.
- **Cancel an upload.** Every upload in flight shows the count of its run —
  *"3 of 12 files"* — beside its own percentage, and the count moves as each
  file lands: a folder of two hundred items reads as one job with a size rather
  than as two hundred unrelated files, and the number is on the row in flight as
  well as on any row of the same run a failure left standing. **Cancel** sits
  beside it — one file, or the whole run a drop or a picker action started, so a
  folder of two hundred items is stopped in one press rather than two hundred.
  What has already gone up stays, and nothing that had not started is sent. The
  switch arrives with the run's **first file**: a drop creates the folders of
  its tree before it uploads anything, and that phase has no row yet to press.
- **Sharing** per file or folder, with rights per person.
- **Attach from Files** in the composer, with no re-upload.
- **Saved into from mail**: a message's attachments can be kept here instead of
  downloaded, into your own files or a group's — the group's account is the
  destination that makes them the group's — and into **any folder inside it**,
  walked or created in the dialog. Offered for **one attachment as much as for
  ten**. A file the chosen folder already holds is reported rather than
  replaced — the one write that still refuses a name, because a file somebody
  already keeps is not a save's to overwrite (ADR 0013).
- One folder is hidden on purpose: **`gilbert`**, contents and all. It holds
  the settings file and signature images, and the Files view drops it from the
  listing so it never reads as a place to file your own.
  Hiding the folder alone would have been worse than showing it — the tree
  attaches a node whose parent is missing to the root, so signature images
  would have spilled into the top level.

---

# Filters (Sieve)

A visual rule builder that round-trips losslessly to a real Sieve script. Rules
are stored inside the script itself as `# rule:{…}` JSON comments, with the
generated Sieve below each one — so the script the server runs is the script you
can read, and the builder can reconstruct the rules from it.

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

Also:

- **Enable or disable** a rule without deleting it, and reorder them by dragging
  or with the up/down buttons — order is what Sieve evaluates in.
- **Raw script editor** underneath, with the server validating before save — a
  script Stalwart will not accept is refused in front of you rather than failing
  quietly at delivery.
- **Preview generated Sieve** for the visual rules.
- **Nothing is discarded without asking.** Both editors keep their edits until
  you save, and every way off the page asks first, offering to save rather than
  making "leave without saving" the easy answer — a settings link, the app rail
  and the Rules/Scripts switch alike. The save bar is pinned to the foot of the
  pane, because a screenful of rules otherwise puts it past the bottom of the
  window. Leaving now asks, offering to save rather than making "leave without
  saving" the easy answer, and the bar is pinned to the foot of the pane so
  "Unsaved changes" is on screen whether or not the rules fit in it.
- **Refuse to save from a script we only partly read** — a save is checked for
  completeness against the shape the generator emits, after a compressing proxy
  once truncated a download and the next save wrote the short version back over
  the real one.
- **Filter messages like this…** from a message's context menu, pre-filled from
  the sender or the list it came from.
- **Apply to the messages already in this folder** — evaluated client-side there
  and then, because the server only runs Sieve on delivery.
- **Folder renames are tracked**, so a rule that files into a folder keeps
  working when the folder moves.
- **Out of office** sits beside it as a JMAP `VacationResponse` — subject, body,
  and an optional start and end — rather than a rule you have to write.

---

# Sharing

Files, calendars and address books share with other accounts on the same server
through JMAP Sharing. Right-click something you own, choose **Share…**, pick
people from the directory, and give each Viewer or Editor — or set the
individual rights by hand.

- **Shared things appear where they belong**, not behind an account switcher.
  Somebody's folder is in Files, their calendar in the calendar, their address
  book in Contacts, each under *Shared with me*. There is no account switching,
  and the door it would be is the wrong one: a switcher moves the whole app —
  every surface, every pane — into somebody else's account, where what was
  shared with you belongs beside your own.
- **Adding is a deliberate step**, for the reason given under Calendar: the
  server reports every collection you can reach. Except for **a group you
  belong to** — its calendars, address books and files are the
  group's own, owned by the group's account and written there at creation
  (never created in yours and shared out), so they answer everywhere without
  anyone adding them.
- **Stopping is separate from hiding** — *Stop sharing* on something you own
  withdraws access from everyone at once, after asking; *Remove from my view* on
  something shared with you changes nothing for anybody else.
- Anything of yours that is shared carries a badge, so you can see at a glance
  what is out there.
- Where the server will not remember that you added a share — 0.16 refuses
  `isSubscribed` on a read-only address book while accepting it on a calendar —
  Gilbert keeps the list in the settings that already follow you between
  devices, so the inconsistency does not reach the reader.
- **Sharing a mail folder is not offered.** Stalwart accepts it, stores it, and
  never delivers it. A folder shared before that was withdrawn still offers
  *Stop sharing*, because a share nobody can see is the one you most want to be
  able to clear.

---

# Cross-cutting

Settings, live updates, the platform surface and security run through both parts:
the settings policy and the immutability are Gilbert's own, and the rest is the
client's machinery, described here because a change in either part has to keep
the other true.

# Settings

## They follow the account, not the browser

Preferences live in a `settings.json` in the account's own JMAP Files, beside
the signature images. So identity, signatures, locale, date and time formats,
theme, labels, templates, folder colours, trusted image senders and added shares
are the same wherever you sign in, private windows included — and they are
backed up with the mail store, because they *are* in the mail store. Gilbert
still stores nothing of its own.

Settings that describe *this screen* stay local, deliberately: density, font
size, sidebar state, the two pane sizes, and the notification toggles, which
track a permission the browser grants per device. The list is written as the
exceptions rather than the rule, so a setting added later syncs by default.

The swipe actions are a deliberate non-exception, and look like one at a
glance: they only do anything on a touchscreen, so they read as belonging to
the device. But someone who has decided that a left swipe deletes has decided
it for their phone and their tablet both, and the desktop that ignores them is
the odd one out rather than the case to design around.

Two limits: conflicts are last-write-wins, and a change made on one device does
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

**Privacy & safety is separate from Security & sessions**, and the line
between them is worth stating because two similar words in one nav is how a
menu becomes something people hunt through. Security & sessions is credentials
and access: password, two-factor state, app passwords, live sessions. Privacy &
safety is how the app behaves towards the reader and towards senders: what
loads, what leaks, and what asks before it happens. That is a different
question from who may get in: a remote image, a read receipt and an undo-send
window all decide what reaches a sender, and none of them is a credential.

Three warnings live there, and **all three start switched off**. That is not
timidity: a client that begins by interrupting is one people learn to click
through, and a warning clicked through without reading costs the same attention
and buys nothing. The first could not be on by default in any case — it
measures against the domains that count as yours, and with nothing configured
every message in the mailbox is from outside.

- **Messages from outside** get a banner naming the sender's domain. Your own
  identity domains are always inside and are not configuration; anything listed
  is additional, and covers its subdomains. The match is on a dot boundary, so
  `example.com` covers `mail.example.com` and not `notexample.com`, which is the
  shape somebody registers on purpose.
- **Sending outside** names the outside recipients and asks, rather than
  refusing. A rule — "this is going outside" — is not something the sender can
  check; a list of addresses is.
- **Sending to a large group** asks once the count crosses a threshold you set,
  which catches a reply-all onto a long thread. It counts people rather than
  headers, so one address in To and nine in Cc is a message to ten.
- **Opening a link** asks before following it, for a destination not on the
  trusted list — and *always* where the link's own text names one domain and
  its destination is another, even when that destination is trusted. Being
  trusted is not the same as being the place the text claimed. A domain can be
  trusted from the dialog, except on that mismatch: what would be trusted there
  is the destination, and the destination is not the thing in question. Links
  that are not http or https are left alone, since warning about a `mailto:` is
  noise, and noise is how a warning stops being read. Both message bodies are
  covered — a link in a plain-text mail is linkified by Gilbert and points
  wherever it likes just as readily as marked-up one.

The senders trusted with remote images are listed there and can be withdrawn
one at a time, an addition made from a message included.

Settings **export** to a JSON file and **import** back, and reset to defaults.

## Dates, times and locale

- **~620 locales** — every tag CLDR has real data for, each named in its own
  language and script, generated by probing `Intl` rather than hand-listed.
- The default comes from the locale Stalwart reports for the account, then the
  browser's.
- **Date order**: locale default, `22.11.2025`, `22/11/2025`, `11/22/2025`, or
  ISO `2025-11-22`.
- **12- or 24-hour clock**, applied everywhere.
- **Numerals follow the locale**, except under ISO 8601, which pins date and
  clock to Latin digits.
- Dates are **entered** through Gilbert's own pickers rather than the browser's,
  because browsers render `<input type="date">` in their own locale and ignore
  the page's. Typing is lenient: `22.11.`, `221125`, `6:23pm` and bare ISO all
  parse.
- Editable date boxes are always Gregorian and Latin digits, even where the
  display locale uses another calendar: a Buddhist-era year in a text box does
  not round-trip against a Gregorian grid. Non-Gregorian calendars are not
  implemented.

## Interface language

Eleven languages — English and ten translations — chosen in **Appearance →
Language**, and separate from the date-and-time locale above. Wanting German
dates on an English interface is a real preference and so is the reverse, which
is why they are two settings and not one.

| | |
| --- | --- |
| English | the source language, and what every other catalogue falls back to |
| Deutsch · Español · Français · Italiano · Nederlands · Português (Brasil) | Beta |
| Русский · Українська · 简体中文 · 日本語 | Beta |

**All ten translations are marked Beta, and the label is not modesty.**
The catalogues were produced by AI against standard dictionaries and have not
been read by anybody who speaks the language. That is stated in Settings, next
to a link for reporting anything that reads wrongly, because the alternative —
shipping them quietly — would ask people to trust text nobody has checked. A
language loses the Beta mark when a speaker has read it and said so, which is a
deliberate act by a person and not something a percentage earns.

Two things follow from the design rather than the translation:

- **A missing entry renders its English source.** So deleting a bad line is a
  valid fix, not a regression, and a catalogue is never in a half-broken state.
- **Plurals are asked for, never assumed.** `Intl.PluralRules` decides the form,
  so Russian and Ukrainian get their three (1 письмо, 2–4 письма, 5+ писем) and
  Japanese and Chinese get the one they actually have — with counters doing the
  work a plural would: 通 for messages, 件 for conversations.

The interface language also feeds the *automatic* date locale, so choosing
日本語 gives Japanese month and weekday names without setting the region too.
`<html lang>` follows it, which is what stops a browser offering to translate a
page that is already in the reader's language — and accepting that offer is
what rewrites the DOM underneath React.

Only languages with a catalogue shipped appear in the picker. A language
offered without strings behind it would leave the page claiming to be in a
language it is not, which is worse than not offering it: it stops a browser
offering to translate a page the reader cannot read.

## Themes

Two questions, asked separately: **which palette** and **light or dark**. One
setting for both works for exactly one palette and stops working at two.

| Palette | |
| --- | --- |
| **Classic** | The plain light and dark this app has always had |
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

Every one has both halves, so the theme switch in the account menu only ever
changes the side and never the colours. Accent colours still sit on top of any
of them.

The ten borrowed palettes are the work of their own projects and are used
under the MIT licence — see [NOTICE](NOTICE). Only the published colour values
are used, taken from each project's own repository; the values as fetched are
recorded in `.palette-sources/palettes-upstream.md`.

**The shades between those values are derived, and every one is checked.**
Gilbert needs about thirty tokens and these projects publish between twelve
and twenty, so the tiers in between are computed by
`scripts/build-palettes.py`, which then measures every text colour against the
surface it sits on — 4.5:1 for prose, 3:1 for borders and marks — and lifts
anything that falls short, towards white on a dark ground and towards black on
a light one so the hue survives. The script refuses to write a palette that
would not pass.

That check is not a formality. **Twenty-one of the twenty-two palette halves
needed at least one lift**, because these palettes are designed for code
editors rather than for prose at this size: Dracula's comment grey is 3.03:1 on
its own background, and Rosé Pine's gold is 2.7:1 on Dawn. Shipping them as
published would have quietly ended the WCAG AA claim two sections down.

Body text is lifted the same way. Checking each body colour and either
accepting or rejecting it would turn away five of the six palettes added in
September 2026: most of them target
around 4.5:1 for body text, their own goal, where Gilbert asks 7:1 of the text
a reader looks at all day. Rejecting a palette over a bar its designers never
aimed at is the wrong answer when the same arithmetic already adjusts muted
text, links and accents. Solarized Light moves 4.13 to 7.07 that way; Primer
needed nothing in either half.

---

# Live updates and notifications

- **JMAP push over EventSource**, proxied by Gilbert's server so the browser
  never holds credentials. State changes arrive per type, and each store
  refreshes only what changed.
- **Polling behind it** for networks that cut long-lived connections, and
  reconnection on a fixed one-second heartbeat for as long as the tab is open.
  Each failed attempt probes a cheap route: if it answers, the stream is blocked
  rather than the line, and the same catch-up that runs on reconnect runs there
  too — one definition, so the fallback cannot cover less than the live path
  does. On desktop, the header shows which of the three states it is in —
  connected, reconnecting, or off and polling — and the dot beside the brand
  says on hover whether the server answered at all (it closed the stream) or
  could not be reached.
- **Unread count in the tab title and painted onto the favicon**, so the tab
  tells you before you look.
- **Desktop notifications** for new mail and new chat messages while Gilbert is
  open and the tab is in the background, with a sound. Both switches start
  **on** for a new device; the system permission is the browser's, and is asked
  for in the gesture that turns a switch on and prompted for when a switch is
  on and the browser has not answered.
- **Web Push** for notifications with Gilbert **closed**, where the server
  signs with VAPID (RFC 9749). Nothing in that path touches Gilbert's server —
  Stalwart talks to the browser's push service directly, so there is no relay to
  run. The subscription asks for **`EmailDelivery`**, not `Email`: a delivery is
  the only thing that wakes it, where `Email` also changes on every read, flag
  and move from any client — each of which arrived as a notification that could
  only say "New mail". Where the server also implements `emailpush`, the
  payload carries the message's `id` and `threadId` as well as the sender,
  subject and preview, which is what lets a notification be tagged by message,
  offer Archive and Mark-read, and open the message rather than the inbox;
  without it the notification says only that mail arrived. Nothing is shown
  while a focused Gilbert window is on screen, since that window is already
  being told by its own event stream. Offered only on a device you said was
  yours.
- **The subscription is one row per device, and it wakes for a group's mail and
  its chat.** A push subscription belongs to the principal that registered it
  and is served for every account that principal is a **member** of — their own
  and each group mailbox. A group's mail wakes a closed Gilbert as a
  notification that names nothing; what is not built is the per-account payload
  that would name the sender, the subject and the mailbox it landed in. A chat
  message wakes it through `FileNode`, and the worker reads the newest nodes of
  the group's chat folder back and announces what is newer than the watermark
  and not the reader's own (ADR 0016, whose live-server probes stay owed). Read
  from Stalwart's source at v0.16.22.
- **A full account is not the end of notifications.** Stalwart allows fifteen
  subscriptions per account, shared with Gilbert's own server-side row, and the
  sixteenth create is refused `overQuota`. The client releases its own rows
  before registering, and on that refusal gives up one belonging to another
  browser — never verified first, then the one closest to expiring — because a
  row left behind by a browser whose site data was cleared can never be reached
  again, and the device it belonged to registers afresh the next time it is
  opened.
- **The switch says why it cannot be offered** where it cannot: a mail server
  with no push key, a browser with no Push API, and — the sentence worth
  writing — an iOS browser opened as a tab, which is told to add Gilbert to the
  Home Screen in Safari, because that is the install that gives it the feature.
  The notification permission is asked for in the gesture that turns a switch
  on and nowhere else, and a permission the browser no longer holds an answer
  for is said out loud, with the switch's own gesture named as the repair.
- The verification code a subscription needs is handed to an open tab, or left
  in the browser's cache under a key **anchored to where the app is mounted**
  for the next tab to collect. Both sides name it absolutely: a relative key is
  resolved against the URL of whoever asks, so the agent at `<base>/sw.js` and
  a tab at `/mail/inbox/…` were naming two different entries, and agreed only
  when the open page happened to be the root.
- **The subscription is renewed on every app start**, because a JMAP push
  subscription expires — seven days is the ceiling — and re-registering before
  it lapses is the client's job. Renewal happens with a page open, and the
  reason is *when* the service worker runs rather than what it is allowed to
  do: it only wakes for an event, and the event that would wake it is a push
  that stops arriving the moment the subscription lapses. A renewal that can
  only run while renewal is still unnecessary is no schedule at all. So the
  guarantee is that background notifications keep working as long as Gilbert is
  opened now and again, and the two-day renewal window means
  once a week is enough. A browser that dropped or rotated its subscription on
  its own is re-subscribed at the same moment, rather than left with a switch
  that says push is on and a browser that is no longer listening.
  Registration is per browser, not per account: a phone having push does not
  make it on for the desktop, and each device tracks its own.
- **A subscription is extended rather than replaced.** Registering again was a
  create, and Stalwart keeps every create — a repeated `deviceClientId` does not
  replace the row it repeats (confirmed live on 0.16.22, 2026-09-16) — so a
  renewal that ran inside the window added a row every time until the account's
  fifteen were gone. A registration now finds the row it already has, extends
  its `expires` where the server accepts it, releases any duplicate of its own,
  and starts a fresh one only when the endpoint actually changed.
- **The rest of a build is fetched in the background.** The app page carries
  the list of its own scripts (written at build time, prefixed with the mount),
  and the service worker reads it back and fetches what it does not hold, three
  at a time, on each navigation — so the first time after a deploy that a reader
  opens the composer, settings or a viewer, that code is already here rather
  than waited for. The build's lazy views are hundreds of kilobytes each, which
  is what makes it worth doing. Language catalogs are left out (one per
  language, used one at a time), and nothing is fetched ahead when the reader
  has asked the browser to save data. The kept copy of the app page is refreshed
  from every navigation and is used only when the network is not there.
- **Stale build reload** — when the server starts serving a build the open tab
  did not come from, the tab reloads itself rather than going on talking to a
  newer server with older JavaScript. The reload is unconditional once the
  versions differ: a compose window holding an unsent draft is the deliberate
  price, because a tab running code the server no longer speaks is the worse
  failure. The version is asked for whenever the tab could have missed a
  deploy — a slow poll while the tab is visible, the tab becoming visible
  again, the push stream dropping, and every navigation. The session survives
  the reload: it lives in the sealed cookie and the server's session file,
  not in the tab.
- **Crash recovery** — the last line between an uncaught error and a blank
  page. An error no boundary catches unmounts the whole tree, which is the
  shape of a lazy view whose chunk failed to load — gone after a deploy, or
  at the same build when the fetch died with a connection that stopped while
  the tab sat idle. A root boundary catches it, writes the crash down where
  the reload cannot erase it (`localStorage`, readable for support), and
  reloads. Automatic reloads are bounded so a genuine bug cannot loop the
  page: never while the page is less than a minute old, and at most two per
  ten minutes per tab, remembered across reloads — a crash that survives two
  attempts is left for a human, with the record intact. Lazy views carry a
  twenty-second load timeout, so a chunk request that hangs on a dead
  connection is treated as the same failure instead of leaving a spinner for
  ever.

---

# Platform

- **Installable PWA** with a service worker: the app shell is cached for
  installability and fast loads, API requests never are, and navigations are
  network-first with the shell as fallback. The worker's own script is asked for
  hourly with the HTTP cache bypassed, so a corrected or re-versioned worker
  lands in a tab that never navigates; an actual deploy is noticed by the
  version check and reloads the page. The manifest carries Gilbert's own
  icons — a 192 and a 512 for `any`, and a third declared `maskable` for the
  launchers that crop one to their own shape — and its splash colours are the
  default theme's background, so an installed app opens in the colours it is
  about to be, not in another theme's. The artwork on them is the mark on its
  own dark navy rather than the lockup: the wordmark inside a 192px square is a
  texture, and the tagline is dropped below 180px, where it is a smear rather
  than a word.
- **Install from the app's own banner and menu.** On a phone a dismissible
  banner sits under the top bar and the account menu carries the same command,
  because the browser's own prompt is easy to miss and cannot be reached from
  the menu. The command is **Install mobile app** while there is something to
  install -- it shows the browser's prompt (`beforeinstallprompt`, captured at
  start-up so the tap that wants it can show it) or, where the browser has no
  prompt, Safari's Share-sheet steps or a browser that keeps install in its own
  menu -- and **Mobile app** once installed. An installed app is never offered
  the install again: the banner asks whether to use the app that is already
  there and stops asking once dismissed. The dialog keeps the app current
  (**Update now**, enabled only when the server is serving another build, with
  the worker's script asked for first) and turns notifications on for the
  device, through the same permission and subscription path Settings uses
  (`lib/installApp`, `lib/staleBuild`, `lib/webpushEnable`).
- **Manifest shortcuts** for Compose, Calendar and Contacts.
- **One window, not one per launch.** A `mailto:` link, a shortcut or a
  notification opened while Gilbert is already running arrives in the copy
  that is running. Two windows on the same inbox disagree about what has been
  read, and only one of them is where the half-written reply is.
- **The unread count on the installed app's icon.** The tab title and the
  painted favicon are the same idea for a browser tab, and an installed app has
  neither -- in `display: standalone` there is no tab strip and no favicon on
  screen, so a home-screen Gilbert showed nothing at all. Web Push marks the
  icon while the app is closed, with a dot rather than a figure: the service
  agent is not told how many messages are unread — a push carries the new mail
  rather than a total, so counting the payload would badge "2" over an inbox
  holding forty. The next tab to open writes the real count over it. The agent
  could ask for the count instead, though whether a badge is worth a request on
  every push is a separate question and has not been answered yet.
  Unsupported browsers show nothing, as does iOS until notification permission
  has been granted, which is that platform's condition for a badge.
- **In the share sheet** — share a photo, a link or a file from any other app
  and Gilbert is one of the places it can go, opening a draft that holds it.
  The subject comes from the shared title, the text and the link become the
  body above your signature, and files are attached and start uploading. It
  addresses nothing: a share says what to send, never who to.

  A share is a POST, which is not something a client-side router can answer, so
  the service worker takes the body, leaves it where a tab can collect it and
  redirects to the app. That indirection is also what lets a share to a
  signed-out Gilbert work — it waits through the sign-in page and opens after,
  which the query string could not have survived. One nobody comes back for
  expires after ten minutes rather than opening a composer full of a forgotten
  photo the next time you look. The agent is what answers it: with the agent
  unregistered the POST has nothing to receive it and the share is lost, which
  is the one cost of a target the manifest announces unconditionally. Android
  and Chromium only; iOS does not implement share targets.
- **Acting on a notification.** Archive and Mark as read sit on the
  notification itself, and both happen where you are — the phone stays in your
  hand, or in your pocket. They are the two a phone shows: `maxActions` is two
  on Android, and anything past it is dropped silently, so these are the two
  worth having rather than the two that came first. Reply is deliberately not
  among them, because it would have to open the app, and tapping the
  notification already does that.

  Nothing in the Master's shape stands in the way. Gilbert's session is an
  httpOnly cookie against its own origin, and the only
  other thing the API asks for is a fixed header that is not a secret. A
  same-origin request from the service worker carries the cookie like any
  other, so `Email/set` from a notification is an ordinary call. What the
  agent genuinely cannot reach is anything a *tab* holds in memory — and the
  API asks for none of it.

  What it cannot reach is a catalogue. The agent is plain JavaScript outside
  the bundle, with no i18n and no idea which mailbox is the archive, so the app
  writes both down for it whenever the language, the account or the folder list
  changes. Where there is no such note — between installing a new agent and
  next opening Gilbert — the notification appears with no action buttons at
  all rather than English ones over a guessed mailbox.

  A session can still be gone by the time a button is pressed: expired, signed
  out, or a cookie that did not outlive the browser. That comes back as a
  refusal, and the notification says so rather than disappearing as though it
  had worked. It does not open the app to recover — being interrupted is the
  thing the button existed to avoid.
- **Share** — a message, or one attachment, handed to the operating system's
  share sheet instead of to the filesystem. On a phone a download is close to a
  dead end: the file lands in Downloads and whoever wanted to send it somewhere
  goes hunting for it in a file manager. The sheet is on the message menu, on
  each attachment row, and in the file viewer, which is where an attachment is
  already open. A message shares as text rather than as the `.eml` beside it,
  because a share sheet is aimed at everything that is not a mail client and an
  `.eml` in a chat app is an attachment nobody can open. Every one of those
  controls is drawn only where the browser has Web Share -- absent on desktop
  Linux and in Firefox -- and sharing a file is asked about separately from
  sharing at all. Where the share cannot be made, the download it sits beside
  happens instead, so the worst case costs a tap rather than the file.
- **`mailto:` handler** — registered from Settings › General for the browser
  (needs HTTPS; Safari does not support it), and declared in the manifest so an
  installed Gilbert is offered by the operating system wherever something asks
  for a mail client. Links arrive with recipients, Cc, Bcc, subject and body
  filled in.
- **Deep links**: `/mail/:mailboxId?/:threadId?`, `/search/:threadId?`,
  `/calendar/:view?/:date?`, `/contacts/:id?`, `/files/:nodeId?`,
  `/settings/:section?` — every view, down to an open conversation, is
  addressable, and the back button works.
- **Printing** a message uses the browser's own print.

## Keyboard shortcuts

Gmail-style and always on; there is no setting to enable them. `?` shows the
list anywhere. Two-key sequences (`g` then `i`) have a 1.2-second window.
Nothing fires while you are typing, or while a dialog or menu is open, except
three composer bindings that are the point of the exception. Shortcuts register
per view, so the same letter can mean different things in mail and the calendar.
`Ctrl` is `Cmd` on a Mac, and the help dialog shows which it picked.

| Where | Keys |
| --- | --- |
| Global | `?` help · `/` search · `c` compose · `g i/s/t/d/a` inbox, starred, sent, drafts, all mail · `g l/c/f/k` calendar, contacts, files, settings |
| List | `j`/`k` next/previous · `o` open · `u` back · `Esc` back or clear selection · `x` select · `Ctrl+A` select all |
| Acting | `e` archive · `#` delete · `!` spam · `s` star · `Shift+I`/`Shift+U` read/unread · `v` move · `l` label |
| Conversation | `r` reply to the sender · `a` reply all · `f` forward · `n`/`p` next/previous message · `]` archive and open next |
| Composer | `Ctrl+Enter` send · `Ctrl+S` save draft · `Esc` close, saving |
| Calendar | `t` today · `n`/`p` next/previous · `d`/`w`/`m`/`a` day, week, month, agenda · `c` new event |

Aliases exist and are left out of the in-app list on purpose: `↓`/`↑` for
`j`/`k`, `Enter` for `o`, `y` for `e`, `Delete` for `#`. Contacts and Files
define no shortcuts of their own; the global set still applies.

---

# Security and privacy

## The browser never holds a credential

Sign-in posts the username and password once. The server seals them with a key
derived from the session's own cookie secret combined with the app secret —
`secret` in the installation's own document, and `APP_SECRET` in a process with
no boot (HKDF-SHA256 → AES-256-GCM) — and keeps only the ciphertext plus a hash of the
cookie secret. A stolen session file cannot be turned back into passwords
without also holding the users' cookies. The browser gets an `HttpOnly`,
`SameSite=Lax`, `Secure`-when-HTTPS cookie and nothing else; every JMAP call
goes through `/api/jmap` on the same origin.

## "This is my own device"

A tickbox on the sign-in page, **unticked by default**, because the answer that
costs something to get wrong is the one that assumes the machine is yours.

| | Unticked | Ticked |
| --- | --- | --- |
| Stays signed in | until the browser closes | up to 30 days (`SESSION_REMEMBER_TTL`) |
| Idle sign-out | after 5 minutes | none |
| Kept on the computer | nothing | settings cache, recent addresses, username |
| Background notifications | refused | available |

Local storage is gated on that answer for **reads** as well as writes — a
machine trusted once still has residue, and honouring it would let a previous
session's data surface in a later untrusted one. Signing out clears the settings
cache and recent addresses and tears down the push subscription, whichever
answer was given.

The idle timer exists because the alternative does not work: `beforeunload` text
was removed from browsers years ago, and **no event fires at all** for walking
away from a signed-in screen, which is the case that matters.

## Server hardening

- **CSP** on the app: `default-src 'self'`, `script-src 'self'`, `object-src
  'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`.
  Proxied blobs get a far stricter one — `sandbox; default-src 'none';
  style-src 'unsafe-inline'; img-src data:`.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, a `Permissions-Policy` that allows the
  **microphone to the app itself** — the phone registers a SIP leg through it —
  and denies camera, geolocation, payment and USB, `Cross-Origin-Opener-Policy:
  same-origin`, HSTS over HTTPS, and `Cache-Control: no-store` by default.
- **CSRF**: every API call must carry `X-Requested-With: gilbert`, and any
  request whose `Sec-Fetch-Site` is not same-origin is refused outright.
- **Rate limiting** on sign-in, keyed by IP *and* IP+username, with
  `Retry-After`; a separate limiter guards the endpoints that check a password.
  An **IPv6 address is counted by its /64** — one host holds a whole prefix, so
  a limit keyed on the full address is no limit — which is the bargain an IPv4
  NAT already makes. The never-refunded flood ceiling is consulted **before the
  body is read**, since it needs nothing from it.
  Client IP is taken from `X-Forwarded-*` only for peers in `TRUSTED_PROXIES`
  (loopback and the private ranges by default) — otherwise anyone could pick
  their own key for the limiter.
- **Body limits.** Every API route that reads JSON takes at most 64 KiB, except
  the data path (`/jmap`, `/upload`), which carries real mail and is capped and
  streamed where it is sent on; sign-in is capped tighter still, at 16 KiB, as
  the one endpoint that reads a body from somebody not yet signed in. A checked
  `/jmap` body (ADR 0017) is bounded three ways: 4 MB each, four reads per
  session at once, and 32 MB across everyone, where exceeding the shared budget
  answers `503 busy` rather than taking the process down.
- **Upload and timeout limits** on the proxy (`MAX_UPLOAD_BYTES`,
  `UPSTREAM_TIMEOUT`).
- **Byte ranges on a download**, so a PDF preview pages through a file instead
  of pulling all of it: a well-formed `Range` is forwarded to Stalwart, which
  honours a single range, and the 206 and its `Content-Range` are passed back.
  The proxy advertises `Accept-Ranges: bytes` itself, because Stalwart honours a
  range without saying so and a PDF viewer reads in pieces only when the first
  response says it may. A range the server cannot serve comes back as the whole
  file with a 200, never a 416, and a malformed one is dropped rather than
  forwarded.
- **The bundle is served precompressed, and revalidation is free.** The web
  build writes a Brotli and a gzip copy of every compressible file
  (`scripts/precompress.mjs`), and the static handler hands over the smallest
  one the browser accepts, with `Vary: Accept-Encoding` — Brotli at the quality
  worth using is far too slow to run per request, which is why the bundle used
  to be gzipped again on every request instead. Every static file carries an
  `ETag`, and a matching `If-None-Match` gets a 304: the shell and the
  never-stale files are revalidated on every load, and without a validator each
  of those revalidations downloaded the whole file again. A precompressed copy
  older than the file it was made from is ignored rather than served.
- **Attachment and proxied-image responses are `no-store` on a device that is
  not the person's own.** Signing out wipes what the app stores; the browser's
  own disk cache is the one it does not reach. Filenames attached to a message
  are shown and saved with **direction controls stripped**, so a sender cannot
  make one read as another.

## The image proxy is SSRF-safe

Approved remote images are fetched by the server, so every request is checked
before it is made: the hostname is resolved and **every** answer must be
acceptable — one bad record fails the fetch — and private space is refused in
both families (RFC 1918, loopback, link-local, CGNAT, multicast,
IPv4-mapped IPv6, unique-local, and NAT64, which reaches IPv4 space). Responses
are capped at 15 MB, served under the sandbox CSP above, and identified by their
own user agent.

## Self-service credentials

Over Stalwart's own registry objects, so there is no administrator in the loop:

- **Change your password.** Where the account is backed by an external directory
  (LDAP, SQL, OIDC) Stalwart refuses, and Gilbert shows the server's own reason
  rather than inventing one.
- **App passwords** — create, list and revoke a separate password per mail app
  or device. Creating one **asks for the account's current password**, the way
  disabling 2FA does: it is a standing credential that outlives the session,
  so a session merely left open on somebody else's machine must not be able to
  mint one. The password is compared against what the session already holds, so
  a wrong guess never reaches Stalwart's auto-ban — which counts failures
  against the proxy's address, shared by everyone — and the server is asked
  only when turning on 2FA moved the session onto an app password. Minting one
  has a **rate-limit budget of its own**, separate from the password change and
  the 2FA switch, because its check is answered without asking the server.
- **Active webmail sessions** — see them, and revoke every session but this one.
  A session is grouped by **the account Stalwart names on the server it lives
  on**, not by the string that was typed at sign-in, so a session opened as a
  bare or differently cased username is the same account here and does not
  survive the revoke.
- **Signing out leaves nothing of the session behind**, composers included: a
  send still inside its undo window goes on the way out, then every open
  composer is closed, so the next person at a shared machine does not find the
  last one's draft open and able to send it.
- **Two-factor**: an account that has it can turn it **off** here. Turning it
  **on** is not offered, and there is no code field on the sign-in page.
  Stalwart accepts a TOTP code only through an OAuth flow and offers no password
  grant, so a client holding a username and password cannot exchange them plus a
  code for a token. **An account with 2FA signs in with an app password.** A
  rejected sign-in that carried a code says exactly that rather than "invalid
  credentials". Doing it properly means implementing OAuth; that is in
  [ROADMAP.md](ROADMAP.md).

## Checking a signature

A signed message says who signed it, and Gilbert checks whether that holds up.
This is S/MIME only, and it stops at reading: nothing here signs, encrypts or
decrypts anything.

**What it checks.** For a `multipart/signed` message carrying a PKCS#7
signature, the exact bytes of the signed part — headers included, canonicalised
to CRLF — are hashed and compared against the `messageDigest` the signature
covers, and the signature over the signed attributes is verified with WebCrypto
against the certificate travelling inside the message. RSA (PKCS#1 v1.5) and
ECDSA over P-256, P-384 and P-521 are supported, with SHA-256, SHA-384 or
SHA-512.

**What a check is allowed to claim, which is the whole design.** A browser has
no system trust store, and the certificate arrives inside the message, so anyone
can self-sign as anyone. On its own a verified signature proves only that
whoever wrote the message held the key attached to it — which is why Gilbert
never renders the bare word *verified*.

What makes it worth anything is remembering. The first signed message from an
address pins that certificate's fingerprint in your settings; later ones are
compared against it. That is trust on first use, and it needs no certificate
authority:

| what happened | what you see |
|---|---|
| first signed message from this address | *"Signed by X, seen here for the first time"* — grey, and deliberately not congratulatory |
| same certificate as before | *"the same signer as before"* — the only case that gets a tick |
| **different certificate than before** | **loud**: both names, and told to check by some other route |
| valid signature, certificate for a different address | **loud**: the signature is not for this sender |
| body changed after signing | **loud**: the signature does not check out |
| signed, but uncheckable | grey, and careful to say *could not check* rather than *did not check out* |

The pins live in the account's settings file rather than in the browser, so the
same correspondent is not greeted as new on every device — which is what trains
people to click past the one warning that matters. A pin records the message
that created it, so the message which established a signer keeps saying so
rather than appearing to be corroborated by itself. A signer that changed, one
whose certificate does not name the sender, or one already expired is never
pinned: writing an anomaly into the baseline would make every later message
agree with it.

**What it will not do.**

- **OpenPGP is not checked**, and says so by name rather than as an unknown
  format. The signature does not carry the key, and Gilbert has nowhere to get
  a correspondent's public key from — `x:PublicKey` holds the account's *own*
  keys, and fetching from a keyserver or WKD would leak who you correspond with
  to a third party, which is the exact thing the image proxy exists to prevent.
- **No chain of trust.** Nothing is validated against a certificate authority,
  no CA bundle is shipped, and revocation is not checked. "Issued by" reports
  what the certificate says, and a self-signed certificate says it issued
  itself.
- **SHA-1 signatures are refused**, not reported as valid.
- **RSA-PSS is declined** rather than attempted, because guessing the salt
  length wrong would report a good signature as bad — a worse thing to say than
  "cannot check".

The verifier is a separate bundle chunk, loaded only when a message's structure
says it is signed, so reading ordinary mail costs nothing for any of this.

## Privacy by default

Remote images blocked, the proxy on, read receipts never automatic, no
telemetry, no third-party requests from the app (the CSP would refuse them), and
no analytics. The only network calls the browser makes are same-origin.

---

# Running it

## Immutable, in the exact sense

Nothing in the container is durable and there is no path to clear: sessions,
settings, the installation's own configuration and every document a feature
owns live in Stalwart, in the accounts they belong to. [README.md](README.md)
states the run itself and what `IMMUTABLE=1` asserts; what is worth adding here
is what the image must not carry, and how to check it.

Sessions are in that set like everything else (`server/src/sessions.ts`), so a
redeploy does not sign anybody out and the flag costs nothing to keep on.

The image ships no `VOLUME` line: one would make Docker mount an anonymous
volume whether asked for or not, and that mount stays **writable under
`--read-only`**. Gilbert's own image carried exactly that bug until 2.16.117,
found by running the check rather than trusting the flag:

```bash
docker inspect <name> --format '{{.HostConfig.ReadonlyRootfs}}'
docker inspect <name> --format '{{json .Mounts}}'    # the one people skip
```

## Configuration

The installation's configuration is **one document in Stalwart**:
`installation.json`, in the Master account's own `gilbert` app folder. A boot
signs in as the Master, reads it whole, and runs on it
(`server/src/bootstrap.ts` → `server/src/config.ts`); the first boot creates it —
the defaults and a freshly generated app secret — and **Administration →
Installation** edits it from then on. Nothing about it is on the container, so a
redeploy reads back exactly what the last edit wrote, and a publish is in force
from the **next boot**: the running process keeps the configuration it booted
with.

The environment carries four classes of value. The names and
the defaults are the same in both paths, so a process that never boots — a test,
a tool, a development server started without a sign-in — runs on what the
environment states (`server/src/configuration.ts`).

**The handshake** — how Stalwart is reached, and which account holds the
document. The three below have no defaults: a boot that finds one missing stops
and names it. They cannot come from the document, because the document lives in
Stalwart.

| Variable | Does |
| --- | --- |
| `STALWART_URL` | Where Stalwart is; the JMAP session is discovered at `/.well-known/jmap`, and it is the default for a domain the routing table does not list |
| `GILBERT_AGENT_ADDRESS` | The Master's own address (ADR 0003): the account a boot signs in as, and whose app folder holds this installation's document |
| `GILBERT_AGENT_PASSWORD` | The credential that account signs in with — its own password, never an app password |
| `STALWART_FOLLOW_ADVERTISED_URLS` | Off by default: only the path and query are taken from a URL Stalwart advertises, with scheme, host and port from `STALWART_URL`; a deployment that must reach Stalwart at a different origin than the one it was given sets it |

**The container's own facts** — what this process was given, not what the
installation decided. `HOST` and `PORT` override the document when the container
states them; when it states neither, the document's `server.host`/`server.port`
decide. `IMMUTABLE` is an assertion the server checks rather than a switch: it
probes the filesystem and refuses to boot when it turns out to be writable after
all.

| Variable | Default | Does |
| --- | --- | --- |
| `HOST` / `PORT` | the document's | Listen address |
| `IMMUTABLE` | off | Assert **and verify** that nothing is writable |
| `BASE_PATH` | the domain root | Which prefix this instance serves — the image's fact, and not in the document — see below |

**The image's own facts** — what this process *is*, rather than what this
installation decided.

| Variable | Default | Does |
| --- | --- | --- |
| `STATIC_DIR` | the built bundle inside the image | Where the web bundle is |
| `SOURCE_URL` | this repository | Where **your** source is, for the AGPL offer |
| `GILBERT_ADMIN_PERMISSION` | `sysAccountCreate` | The `/api/account` permission that marks a Stalwart admin (ADR 0001) |
| `GILBERT_VERSION` | from git in a checkout | The version this build calls itself; the image is built with it (`--build-arg`) |
| `NODE_ENV` | — | Whether this is a production process, which is what the two boot refusals below read |

**The operator's own statement** — `GILBERT_AGENT_ALLOW_PRIVATE_PROVIDER`, off
by default: whether this deployment may point the installation's model at an
address inside its own network. It is read from the environment and nowhere
else, because an installation must not grant itself that right; the document
does not carry the field, and a document that still carries
`agent.allowPrivateProvider` is read as though it did not.

**Everything else is the document's**, in the sections the Installation editor
shows: `server` (whether a proxy is trusted and which peers, the `Secure`-cookie
posture, the session cookie's name — `gilbert_session` unless the installation
names it otherwise — and whether the JMAP response is compressed),
`limits` (the upstream timeout, the largest upload, the remote-image proxy, the
sign-in rate limit, and the per-session budget on the data path), `sessions` (how
long a session lives, and how long "remember me" extends it), `push` (the
live-update mode and the raw-push relay), `upstreams` (the domains served by
another Stalwart — see below), `agent` (the fleet's timers and bounds, whether it
may think or read images, its health port, and whether it runs in the server's
own process) and `branding` (the name this installation shows). Every
`GILBERT_AGENT_*` variable the agent sections below name — `agent.poll`,
`agent.lease`, `agent.chainHops`, `agent.pages`, `agent.vision`,
`agent.authoringMaxPerMonth`, `agent.healthPort`, `agent.inProcess` — is one of
those fields in a booted deployment, and the variable is what a process with no
boot runs on.

The document's `secret` is the key every stored session is sealed with. It is
**generated on the first boot** and written into the document, because a secret
the container holds is a secret a redeploy loses; `APP_SECRET` is what a process
with no boot runs on, and the document decides for a
booted one, so rotating `APP_SECRET` — or leaving it unset — signs nobody out:
a booted deployment is never refused for a missing one, because its secret is
the document's. What `assertServable` (`server/src/config.ts`) refuses, for a
**production** process, is a configuration that states no served prefix at all,
and one whose secret is ephemeral because nothing stated one.

`Caddyfile.example` and `nginx.example.conf` are in the repository, and are the
configuration for TLS and a reverse proxy.

### Serving from a subpath

`BASE_PATH` mounts the whole app under a prefix, for a host that is not
Gilbert's alone:

```bash
docker build --build-arg BASE_PATH=/mail -t gilbert .
docker run -e BASE_PATH=/mail ... gilbert
```

`/mail`, `mail` and `/mail/` all mean the same mount; an empty value means the
domain root. Everything moves together — `/mail/api/health`, every deep link,
the icons, the manifest, the service worker's scope and the session cookie's
`Path`.

Three things are worth knowing before you reach for it.

**The prefix is the image's, not the installation's.** It is deliberately not a
field of the installation document: the value the bundle was built with and the
value the server serves are the same variable, and a document that could move it
could disagree with the bundle it is serving. A production process where
`BASE_PATH` is not set at all refuses to serve rather than guessing, because a
page whose own asset URLs point somewhere else cannot load itself.

**The prefix must arrive intact.** Point the proxy at Gilbert without
stripping it: `proxy_pass http://127.0.0.1:8080;` with no trailing slash in
nginx, `reverse_proxy` without a `uri strip_prefix` in Caddy. A proxy that
strips the prefix is talking to an app at the root, and the build has to agree:
both are made with `BASE_PATH=""`, which is a stated prefix rather than a
missing one.

**It is baked in at build time, not only at run time.** This is the one setting
that cannot wait for the process to start: the web bundle writes its own
`<script src>` into `index.html` when it is built, so a build that does not
know the prefix produces a shell that cannot load itself under one. Hence the
`--build-arg` above. Get it wrong and the page comes up blank — so the server
checks the built shell against its own `BASE_PATH` at the first request and
says so in the log rather than leaving you with an empty page and a 404.

The manifest and the service worker need neither: a manifest's URLs resolve
against the manifest's own address, and the worker is registered with the
prefix in its script address and in its scope (`web/src/main.tsx`) rather than
inheriting a scope from wherever the file happens to sit. Both follow the
prefix with nothing substituted into them.

## Rebranding

The installation's own name is `branding.appName` in its document (the `APP_NAME`
variable is what a process with no boot runs on), and where **your** source can
be had is a variable the image states; the logo, icons and palette are
files. The mark ships in two colorways — `web/public/img/logo.png` navy for a
light surface, `logo-inverse.png` white for a dark one, and a mark-alone
`mark.png`/`mark-inverse.png` pair for the places the wordmark does not fit —
and a deployment that swaps them keeps both in two colors. If you run a
modified Gilbert, `SOURCE_URL` must point at **your** tree — the AGPL's offer
is for the source of the version being run, and it is shown on the sign-in page
and in Settings › About.

## Operations

- **`GET /api/health`** answers name, version and `ok`, and is what the
  container health check uses. Under a `BASE_PATH` it moves with everything
  else, to `/mail/api/health`; the image's health check follows it.
- **Versions** read `2026.8.30+pr129`: the date of the commit the build came
  from, and the pull request it arrived through (or `+g<sha>` for one that did
  not). It comes from git at build time; nothing writes a version into the tree.
  A build reporting `0.0.0` means nobody passed one, which is meant to look
  wrong. The version deliberately says nothing about Stalwart.
- **`deploy.example.sh`** is a single-host Docker deploy: it fetches, refuses
  anything held back by `.deploy-hold`, shows what is about to ship and asks,
  rebuilds with the right version baked in, replaces the container, waits for
  healthy, and prunes all but the newest `GILBERT_KEEP_VERSIONS` images —
  never the one running. `--yes` skips the prompt but never a hold.
- **Sessions survive a restart** because they live in Stalwart, so an immutable
  instance loses nothing to being replaced.

## Code scanning

GitHub's own code scanning runs against this repository on every push and pull
request, on the **default setup**: configured in the repository's settings rather
than by a file here, analysing the tree with the JavaScript/TypeScript
code-scanning suite (its Actions queries included, so `.github/workflows` is
covered by the same run).

`npm run codeql` is that same analysis on this checkout, so a finding shows up
before it is pushed:

```bash
npm run codeql                  # → CodeQL: 0 result(s).
npm run prepush:full            # the fast gate, then the analysis
```

- **It analyses the files a push would carry.** `git ls-files --cached --others
  --exclude-standard` is the list, exported to a temporary tree: GitHub analyses
  a checkout, so `node_modules` and a built `web/dist` are in front of neither.
  `.gitignore` stays the one place that decides what is ignored.
- **The database is not built inside the repository.** The JavaScript extractor
  skips anything under a `node_modules`, and a database built under one
  analyses nothing at all while reporting it as "no code found"; the work
  directory is the system temporary space, named for a digest of the checkout.
- **It is not part of `npm run prepush`.** The toolchain is a 686 MB bundle and
  one analysis takes a couple of minutes — a gate that cannot run on a fresh
  clone is not a gate. It is found through `CODEQL_CLI`, on `PATH`, or in
  `~/.cache/gilbert/codeql`, and a run without one **fails with the install
  instructions** rather than reporting a clean tree.
- **It exits non-zero on any result**, and prints each one as `file:line`, the
  rule and its `security-severity`. An alert is work to do in the same change,
  like any other finding a gate prints.

Both halves are pinned by tests (`server/src/codeql.test.ts`): the flags the
database and the analysis are given, the suite the settings run, the file list,
and that a run which did not happen reports as a failure rather than as nothing
found.

## The mock server

An in-memory fake Stalwart 0.16 — enough JMAP to develop and demo against with
no real mailbox. `npm run dev:mock`, then `demo@example.com` /
`demo`.

It reproduces the things a naive fake would get wrong, because each cost a live
debugging session: `urn:stalwart:jmap` advertised **per-account** rather than
session-level, identity signatures capped at 2047 **bytes**, `CalendarEvent/set`
speaking Stalwart's vocabulary rather than RFC 8984's, and an occurrence's id
staying put across a write that adds or changes an override. Four switches:
`MOCK_NO_FUTURE_RELEASE=1` advertises FUTURERELEASE and then drops every hold;
`MOCK_NO_REGISTRY=1` omits the Stalwart capability so the sign-in refusal can be
tested; `MOCK_NO_SCHEDULING_SEND=1` refuses a calendar write that asks for
scheduling messages, the way an account without that permission is refused; and
`MOCK_NO_KEYWORD_SORT=1` serves a server that does not implement sorting on
keywords.

---

# What it does not do

The full list with reasons is [ROADMAP.md](ROADMAP.md). In short: no snooze
(nothing in JMAP or Stalwart supports it, and Gilbert holds no password to act
on a mailbox while you are away), no language yet checked by a native speaker,
no two-factor sign-in without an app password, no sharing of mail folders (the
server stores the share and never delivers it), no public links (JMAP shares
with accounts on the same server, and Gilbert has no storage of its own to
mint a link from), and no per-occurrence *this and future* edits (the server
refuses them).
