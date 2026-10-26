# ADR 0035 — Ask Gilbert from a selection

Status: Accepted

Implementation: Not built.
The command is not in the tree. What it will carry: a shared action used by the
Files and group-mail surfaces, a chat-draft store keyed by account and read by
the group chat's composer, and a member route
`GET /api/groups/:name/agent` answering the group's agent and the surface matrix
it carries. The agent needs no new capability: the chat message it is sent is the
one the rule already watches, and the references in it are read with the tools
the agent has (`files.read`, `files.rename`, `mail.read`, `mail.draft`,
`knowledge.read`).

## Context

The agent's catalogue and its matrix (ADR 0038) let a run read and write a
group's files, mail, KB and workorders. A person working in Files or in the
group's mail sees the item the work is about, and what they have to do is say
what they want it done to. Today they must open the group's conversation, type
the mention, and copy the path or the message id by hand — the product knows
both, and asks the person to transcribe them.

The conversation is the right place for the request: it is where the agent is
spoken to, where its report is written, and what the chat rule already watches
(ADR 0029). What is missing is the step between the selection and that message.

## Decision

**A selection becomes a chat draft, and the person sends it.**

- The context menu of a file and of a message in a group's mail carries **Ask
  Gilbert…**, on one item or on several. It is offered only where the agent is
  active: the account is a group the Master's agent serves and the agent has prose
  there. A member route answers that, with the rule's surface matrix beside it, so
  the surface can warn when the rule keeps a surface `off` instead of letting the
  refusal arrive after the fact.
- The command **does not call the agent**. It opens the group's own conversation
  and fills the composer with the mention (`@gilbert`) and a block of references:
  for a file its path (the form `files.*` takes), for a message its id and
  subject (the form `mail.read` and `mail.draft` take). The block is visible and
  is data: the person sees what they are sending, and the model is already told
  that a chat message is data.
- **The person completes the sentence and sends it.** The draft is a message of
  theirs, not the agent's; nothing runs until it is sent. The run that follows is
  the ordinary one: the chat rule wakes, the decision turn reads the message, and
  the plan uses the references it carries.
- **The surface matrix decides what can be done** (ADR 0038), and the authority
  classes decide what needs a person's word (ADR 0028): `files: ondemand` lets the
  run rename the files it was given; `knowledge: off` still lets it **read** the
  naming conventions, because a reading is proof and not an act; `mail: watch`
  lets it read the message and draft a reply, and the reply is sent by a person.
- **The selection is bounded.** A run carries a plan of at most twenty steps, and
  a bulk write is one step per item; the command takes at most ten items and says
  so when more were selected. A larger job is split by the person, not silently
  truncated.
- **A group only.** The command is not offered in a person's own account, where
  no agent serves; it is not offered in a group whose agent is not active. The
  references are the group's own objects, and the agent's tools are bound to that
  account, so a message can name nothing outside it.
- **The reply stays a draft.** Where the request is a reply, the run writes it
  into the group's Drafts; sending is a person's act, as every outward act is
  (ADR 0028).

## Consequences

- A person's request is composed where the objects are, and the agent works it in
  the conversation where the result is read. No new tool, no new authority class,
  no per-feature agent code: the feature is a way to write the message the agent
  already understands.
- The references are text in a message, so a person can edit them and a member
  can type any path or id. That is not a hole: the tools are bound to the group's
  account, the authority classes still bound every act, and the run's report says
  what it did. The block is visible for the same reason.
- A group whose rule keeps a surface `off` shows the command with that surface
  called out, or the run refuses with the code that says so; the matrix is the
  one place the decision lives, and the feature does not duplicate it.
- The chat draft is per account and survives a change of view; an unsent draft is
  a person's text, never a message the agent may read.
- A selection of more than ten items is a request the person splits; the
  alternative — one plan of a hundred steps — would exceed the run's budget and
  hide the point at which it stopped.
