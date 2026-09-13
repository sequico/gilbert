/**
 * The group chat's durable format (ADR 0005) — one definition, both tiers.
 *
 * A chat message is a JSON document in the group account's own JMAP Files:
 * `gilbert/chat` holds one node per message, `gilbert/chat-state` holds one
 * read marker per member (ADR 0005; the folder layout is the group-ownership
 * law). Both the web client and the agent worker read and write those
 * documents, so the shape, the validators and the pure text helpers live here
 * rather than twice — the client keeps what needs its JMAP client, the worker
 * keeps what needs its own (`web/src/lib/chat.ts`, `server/src/agent/chat.ts`).
 *
 * Nothing here touches the network, the filesystem or a runtime API beyond
 * `crypto.randomUUID`, which both Node and the browser provide.
 */

export const CHAT_FOLDER = "chat";
export const CHAT_STATE_FOLDER = "chat-state";
export const MESSAGE_TYPE = "application/json";

/** Messages are plain text; the bound keeps the documents small (ADR 0005). */
export const MAX_TEXT = 4000;

/** How many messages one transcript page holds (scroll-up paging). */
export const CHAT_PAGE = 200;

/** The local part of an address — the chat's short display name. */
export function shortName(address: string): string {
  const at = address.indexOf("@");
  return at > 0 ? address.slice(0, at) : address;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A regex matching `@` immediately followed by one of the given addresses. */
export function mentionRegex(addresses: ReadonlyArray<string>): RegExp {
  if (!addresses.length) return /(?!)/;
  return new RegExp(`@(${addresses.map(escapeRegExp).join("|")})`, "g");
}

/** A principal a message is addressed to, by mention. */
export interface ChatMention {
  kind: "principal";
  /** The principal's address — the chat's identity, the same string as `from`. */
  id: string;
}

/** One message document, immutable once created. */
export interface ChatMessageDoc {
  v: 1;
  /** The member's own address, as the session reports it. */
  from: string;
  /** When the sender's client sent it (display only; ordering is the node's). */
  at: string;
  text: string;
  /** The message this one answers, when it is a quote reply (ADR 0005). */
  replyTo?: string;
  /** Principals the message mentions; optional so old documents stay valid. */
  mentions?: ChatMention[];
}

/** One member's read marker: which message they have read up to. */
export interface ChatMarkerDoc {
  v: 1;
  /** The id of the newest message read, or null when born on an empty chat. */
  lastRead: string | null;
}

/** A message as a store keeps it: the document plus its FileNode identity. */
export interface ChatMessage extends ChatMessageDoc {
  id: string;
  /** Server-side creation time of the node — the ordering key. */
  created: string;
}

/** Properties a message node is fetched with. */
export const messageProps = (): string[] => [
  "id",
  "parentId",
  "name",
  "blobId",
  "type",
  "created",
  "nodeType",
];

function isChatMention(x: unknown): x is ChatMention {
  if (!x || typeof x !== "object") return false;
  const d = x as Record<string, unknown>;
  return d.kind === "principal" && typeof d.id === "string";
}

export function isChatMessageDoc(x: unknown): x is ChatMessageDoc {
  if (!x || typeof x !== "object") return false;
  const d = x as Record<string, unknown>;
  return (
    d.v === 1 &&
    typeof d.from === "string" &&
    typeof d.at === "string" &&
    typeof d.text === "string" &&
    (d.replyTo === undefined || typeof d.replyTo === "string") &&
    (d.mentions === undefined ||
      (Array.isArray(d.mentions) && d.mentions.every(isChatMention)))
  );
}

export function isChatMarkerDoc(x: unknown): x is ChatMarkerDoc {
  if (!x || typeof x !== "object") return false;
  const d = x as Record<string, unknown>;
  return d.v === 1 && (d.lastRead === null || typeof d.lastRead === "string");
}

/** Build a message document — the one writer; callers must not inline it. */
export function messageDoc(
  from: string,
  text: string,
  replyTo?: string,
  mentions?: ChatMention[],
): ChatMessageDoc {
  const doc: ChatMessageDoc = { v: 1, from, at: new Date().toISOString(), text };
  if (replyTo) doc.replyTo = replyTo;
  if (mentions?.length) doc.mentions = mentions;
  return doc;
}

/** The file name of a new message document: unique, opaque, ordered by the node. */
export function messageFileName(): string {
  return `${crypto.randomUUID()}.json`;
}

/**
 * The addresses a reader may mention: everyone who has posted in the
 * transcript, plus the reader. Membership is the grant (ADR 0005) and
 * Stalwart exposes no member list over JMAP, so the transcript is the one
 * source the client can see; a member becomes mentionable the moment they
 * post, and the live FileNode rail makes that visible without a refresh.
 */
export function participantsOf(
  messages: ReadonlyArray<{ from: string }>,
  me: string,
): string[] {
  const seen = new Set<string>();
  if (me) seen.add(me);
  for (const m of messages) if (m.from) seen.add(m.from);
  return [...seen].sort();
}

/**
 * Who a `@` picker offers: the group's members when a roster could be read,
 * and the transcript when none could.
 *
 * The transcript is everybody who has ever posted, and it keeps their
 * messages — so on its own it offers somebody who no longer has a session on
 * the group, and withholds a member who has never written. A roster in hand
 * answers both: it is the group's own list (ADR 0005, read for the
 * installation as the Master, ADR 0003), and it replaces the transcript as the
 * source rather than filtering it. `null` is a roster nobody could read, and
 * the answer is then the transcript as it stands rather than a refusal to
 * offer anyone.
 *
 * `always` is offered whatever the answer is: the reader, who is reading this
 * group's chat, and its agent, which acts there whether or not the server
 * lists it as a member of the group.
 */
export function mentionablesOf(
  participants: ReadonlyArray<string>,
  members: ReadonlyArray<string> | null,
  always: ReadonlyArray<string> = [],
): string[] {
  const out = new Set<string>(members ?? participants);
  for (const address of always) if (address) out.add(address);
  return [...out].filter(Boolean).sort();
}

/**
 * The mentions a text carries: `@` immediately followed by a participant
 * address. First-appearance order, each participant once. The address is the
 * chat's identity (the `from` of a message), so matching is exact.
 */
export function mentionsFromText(
  text: string,
  participants: ReadonlyArray<string>,
): ChatMention[] {
  const known = new Set(participants);
  const out: ChatMention[] = [];
  const seen = new Set<string>();
  for (const raw of text.match(/@[^\s]+/g) ?? []) {
    // A mention at the end of a sentence is followed by the punctuation, not by
    // a space: `@sam@example.org,` names the same person as the bare address,
    // and the same rule has to hold here and in `mentionsName` — a mention the
    // writer makes and the reader does not see is a message nobody was told
    // about.
    const token = raw.replace(/[.,;:!?)\]”"]+$/, "");
    const id = token.slice(1);
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ kind: "principal", id });
  }
  return out;
}

/**
 * Whether `text` addresses `address` by mention.
 *
 * The rule the agent's deterministic pre-filter needs (ADR 0003 resolution
 * 11) and the one the client writes: an `@` immediately followed by the full
 * address, as `mentionsFromText` finds it. A bare `@gilbert` without the
 * domain is not a mention of anybody, which is why the match is exact.
 */
export function mentionsAddress(text: string, address: string): boolean {
  if (!address) return false;
  return mentionRegex([address]).test(text);
}

/**
 * Whether `text` addresses `address`, by its full form **or its local part**.
 *
 * The client writes a mention as the full address (a chip serialises back to
 * `@sam@example.org`), but a person typing `@gilbert` by hand and never
 * picking from the picker leaves exactly that. ADR 0003 resolution 11 says an
 * `@gilbert` mention addresses the agent, so the loose form is the agent's
 * pre-filter and the strict one stays the client's mention contract.
 */
export function mentionsName(text: string, address: string): boolean {
  if (!address) return false;
  if (mentionsAddress(text, address)) return true;
  const local = shortName(address);
  if (!local) return false;
  // The local part is followed by something that ends a name: a space, the end
  // of the text, or the punctuation a sentence ends with. `@gilbert.` in a
  // sentence is a mention; `@gilbert1` is somebody else.
  return new RegExp(`@${escapeRegExp(local)}(?![\\w.@-])`, "i").test(text);
}

/**
 * Whether a reply answers one of `addresses`' messages.
 *
 * A reply counts only when its direct parent is the agent's message (ADR 0003
 * resolution 11) — `parentId` is the reply's own `replyTo`, and `parent` the
 * message it names. Anything deeper in the thread is not an address.
 */
export function repliesToAuthor(
  message: Pick<ChatMessageDoc, "replyTo">,
  parent: Pick<ChatMessageDoc, "from"> | null | undefined,
  address: string,
): boolean {
  return Boolean(message.replyTo && parent && parent.from === address);
}

/**
 * The marker file name for a member.
 *
 * Deterministic per address, so every device of a member computes the same
 * name and reads the same marker. The address is URL-encoded because it is
 * the only character set a file name can rely on across servers.
 */
export function markerNameFor(member: string): string {
  return `read-${encodeURIComponent(member)}.json`;
}

/**
 * Order messages the way the transcript reads: server-side creation order.
 *
 * The message document carries its own `at`, but that is the sender's clock
 * and must not decide the order. The FileNode's `created` is the server's
 * stamp; two nodes created in the same instant tie-break on id so the order
 * is total. Decided at implementation (2026-09-08): FileNode ids are opaque
 * on a real server, so id alone cannot carry creation order, and the ADR's
 * live-server confirmation of a timestamp property is what `created` is.
 */
export function compareMessages(
  a: { created: string; id: string },
  b: { created: string; id: string },
): number {
  if (a.created !== b.created) return a.created < b.created ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * How many of a conversation's messages are unread for the reader.
 *
 * The ADR kinds rule: unread = messages newer than my marker. No marker
 * (never opened) reads as 0 and the transcript shows in full; a marker born on
 * an empty chat (lastRead null) makes everything that came after it unread; a
 * marker whose message is gone reads as nothing unread rather than flooding.
 *
 * `fromStart` says whether `nodes` is the whole transcript or its newest page
 * (the chat store pages the transcript from the tail, see `loadOlder`). It
 * decides only the case below where the marker is not in hand: with the whole
 * transcript, a missing marker means the message was deleted; with a page, it
 * means the marker sits in the older part, so everything held is newer than it
 * and the page is the unread count. Reading that as 0 is how a member who was
 * away for more than a page is told "no unread" over hundreds.
 */
export function unreadCount(
  nodes: Array<Pick<ChatMessage, "id">>,
  marker: { lastRead: string | null } | null,
  fromStart = true,
): number {
  if (!marker) return 0;
  if (!marker.lastRead) return nodes.length;
  const at = nodes.findIndex((n) => n.id === marker.lastRead);
  if (at < 0) return fromStart ? 0 : nodes.length;
  return nodes.length - at - 1;
}
