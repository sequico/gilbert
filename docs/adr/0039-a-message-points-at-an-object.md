# ADR 0039 — A message points at an object, never at an address

Status: Proposed

Implementation: Built. The reference is a kind and an id in the group's own
conversation document (`server/src/shared/chat.ts`: `ChatRef`, `messageDoc`,
`isChatMessageDoc`), written by the agent's `say` (`agent/tools/chat.ts`, its
`refs` argument parsed from `kind:id`), composed into a route where the chip is
drawn (`web/src/lib/agentRefs.ts`, `refHref` and `REF_LABEL`) and rendered by the
conversation (`views/chat/ChatPanel.tsx`), which moves the session to the
conversation's account and navigates **below** the panel. Pinned by
`shared/chat.test.ts`, `agent/tools.test.ts`, `lib/__tests__/agentRefs.test.ts`
and `views/chat/__tests__/chat-refs.test.tsx`.

## Context

An agent answered a person's follow-up with *"non posso generare link ipertestuali
diretti"*: it had the ids — they are what its own tools answer — and no way to
hand one over as something a reader can click. A reader who is told "the two
invoices are archived" and then has to find them by hand is doing the work twice.

The obvious fix — let the text contain URLs and render them as links — is the
wrong one. The text of an agent's answer is written after reading mail a stranger
chose, so a URL in it is an address **somebody outside the group dictated**:
`https://evil.example/…` placed in a thread the agent quotes becomes a link
Gilbert drew and a click the reader makes. It is also a disclosure: a link that
carries a subject line tells a reader the subject of an object they may not be
allowed to open.

## Decision

A chat message may carry **references**: a kind, an id, and — for an event — the
day it is on. Nothing else.

- **`kind` is one of four surfaces** — `thread`, `file`, `contact`, `event` — and
  `id` is exactly what that surface's tool answered. The pair is validated where
  the message is written (`chat.say`), so a document that names a kind this build
  cannot draw is not a message at all.
- **The address is composed where the chip is drawn**, from the kind and the id,
  never stored. A message therefore cannot point anywhere but at an object of the
  account it was written in, and a URL a sender dictates is not a reference: it is
  refused, and the model is told the shape.
- **An event carries its day** (`event:id@YYYY-MM-DD`), because a calendar route
  names a day: a reference that could not land is not one.
- **The object opens below the panel.** The conversation is what the reader is
  looking at; a link in it is a look aside, not a departure. The session moves to
  the conversation's account first, because a reference names an object of the
  group the chat is in and a reader sitting on another account would land on a
  folder that account does not have.
- **A kind added later is three lines and a route**: one label, one case in
  `refHref`, one route that opens it. Nothing in the document changes.

## Consequences

- **No free-text linkification, ever.** A URL written by the agent stays text; the
  only links in a conversation are the ones Gilbert composed from an id it
  validated. A future demand for "clickable links in the agent's prose" is this
  decision's to refuse.
- **The label is the surface's word** ("Mail", "Files", "Contacts", "Calendar"),
  translated where it is drawn, so the chip says where it goes and never leaks
  what the object is called.
- **A message points at an object, not at a place in a list.** A thread opens the
  conversation, an event opens its day, and the object's own state decides what
  the reader then sees — the reference carries no permission of its own.
- **A mail the agent drafts cannot carry one**, because an address in a mail must
  be absolute and the installation's public origin is not something the server
  knows behind its proxy. When that is answered, the same reference can be
  rendered absolute; it is not a second design.
