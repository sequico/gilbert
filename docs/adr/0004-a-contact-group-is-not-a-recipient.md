# ADR 0004 — A contact group is not a recipient

Status: Proposed

This is **gilbertmailer**: the address books and the composer, the two surfaces
a group of contacts is read and written from.

## Context

JSContact gives an address book a second kind of card. Beside the individual
there is `kind: "group"`, whose `members` names other cards — by their `uid`,
not by an address — and which carries no address of its own. A group is a name
for a set of people who are already cards.

Nothing on the wire can carry that set. A message's `to`, `cc` and `bcc` are
lists of addresses (`EmailAddress[]`); Stalwart has no group address and no
expansion of one; no JMAP method resolves a group. Whatever the reader picks in
the composer, what leaves it is a list of individual addresses.

Groups are also the one card a team shares without anybody adding anything: the
address books of a group mailbox the reader belongs to are read like their own
— membership of the group is the subscription, the rule ADR 0005 records for
the group's own storage — while a stranger's book stays out until it is
deliberately added. A group a working group keeps in its own book is therefore
the case this has to work for, and the case a resolver reading only the
reader's own books leaves half-answered.

What a resolver can reach is what the client holds: the reader's own books are
paged in full, a shared account's up to 5 000 cards. The editor already refuses
to put a group inside a group — the member picker offers cards that are not
groups.

## Decision

**A group is a client-side convenience over addresses, resolved when it is
chosen.** It never reaches the wire, a draft or the reply path as a thing.

- **The expansion happens at the point of choice** — the autocomplete in
  To/Cc/Bcc and the recipient picker — and what it produces is the chips for
  the individual addresses. The draft, the send, the reply and the recent list
  keep knowing nothing about groups, so nothing downstream needs a type it does
  not have.
- **One resolver, canonical.** A single definition reads a group card into its
  members, and the composer and the contact card's own "Email group" action both
  go through it. Two implementations of "who is in this group" is how one of
  them comes to disagree with the other — and the one that reads only the
  reader's own books already does.
- **It resolves against every book the reader may read** — their own, a group
  mailbox's, a shared book they have added — which is what makes a group a team
  keeps work for the whole team.
- **One address per member, the preferred one.** A card carrying two addresses
  is one person, not two recipients, and a group must not send them two copies.
- **A member that cannot be resolved, or has no address, is skipped and
  counted.** The rest are added and the reader is told how many were left out; a
  group with nothing usable is not offered as a choice.
- **No nesting.** A group's member is a person: a member of kind `group` is
  ignored, and the editor cannot create one.
- **No threshold of its own.** "You are writing to N people" is asked once, at
  send, by the recipient count the composer already checks.

## Consequences

- The wire, the drafts and the replies are unchanged by this, and so is what a
  sent message can be answered with. A group never becomes an entity that can be
  stale, half-forwarded, or unknown to the reply path.
- The expansion is a snapshot taken when the group is chosen: a member added to
  the group afterwards is not in a message already addressed. That is the
  deliberate reading — a group is a way of naming people once, not a
  subscription that follows a draft — and it is the price of the group never
  surviving into one.
- Reach follows the books, not this feature: a reader who may read the group's
  address book sees the group and its members, and one who may not, does not.
  The feature grants no access of its own.
- Resolution is bounded by the cards the client holds, so a group larger than
  what was loaded expands to what was loaded. The send-time count is what makes
  the real number visible before anything is sent.
- A group with many members becomes many chips. The count warning is the guard
  rather than a cap, because the client cannot know which of a group's members
  the writer would have left out.
- **The building follows this record.** The resolver, the two call sites and
  the group suggestions in the composer are decided here; until they land, the
  one place a group expands is the contact card's own action.
