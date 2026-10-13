import { stableJson } from "@gilbert/shared/json";
import type { ContactCard } from "@/jmap/types";
import { contactCompany, contactDisplayName, newKey } from "@/lib/contacts";

/**
 * Merging two contacts of one address book, decided before anything is written.
 *
 * Two cards become one: the fields they disagree on are the reader's choice, and
 * everything else is combined. The merge is a pure function over the two cards —
 * the conflicting fields to ask about, and the patch the merged card is written
 * with — so the awkward cases are cheap to state and the write itself lives in
 * the store, one step, after the reader has answered.
 *
 * What counts as a conflict follows the editor's own model of a card: the fields
 * that hold **one** value (name, nickname, company, job title, birthday, website,
 * note, photo, and the card's kind) are the ones a choice is offered for, because
 * there is only one slot to fill. The fields that hold a **list** (emails, phones,
 * addresses) are not conflicts at all: two different addresses are two facts about
 * the same person, so they are unioned rather than chosen between.
 *
 * The one-slot fields are still `Record`s on the wire, though, and a card can
 * carry more than one entry in one (a second note from an import, a second
 * website). So a conflict decides **the entry the choice is about** — the first —
 * and every other entry of both cards is kept: the loser's competing entry is
 * dropped and nothing else is. What is not in conflict is combined, always.
 */

/** The one-slot fields a merge can offer a choice for. */
export type MergeFieldId =
  | "kind"
  | "name"
  | "nickname"
  | "company"
  | "jobTitle"
  | "birthday"
  | "website"
  | "note"
  | "photo";

/** Which side of a conflict the reader keeps. `a` is the card that survives. */
export type MergeSide = "a" | "b";

export interface MergeConflict {
  id: MergeFieldId;
  /** English label, translated where it is drawn. */
  label: string;
  /** What each side holds, side by side. `a` is the card that survives. */
  a: string;
  b: string;
}

const KIND_LABELS: Record<string, string> = {
  individual: "Individual",
  group: "Group",
  org: "Organization",
  location: "Location",
  device: "Device",
  application: "Application",
};

function kindText(c: ContactCard): string {
  const kind = c.kind ?? "individual";
  return KIND_LABELS[kind] ?? kind;
}

function nameText(c: ContactCard): string | null {
  const n = c.name;
  const hasValue =
    Boolean(n?.full?.trim()) || (n?.components ?? []).some((x) => x.value?.trim());
  return hasValue ? contactDisplayName(c) : null;
}

function nicknameEntry(c: ContactCard) {
  return Object.values(c.nicknames ?? {})[0] ?? null;
}

function nicknameText(c: ContactCard): string | null {
  return nicknameEntry(c)?.name?.trim() || null;
}

function companyText(c: ContactCard): string | null {
  return contactCompany(c) ?? null;
}

function organizationEntry(c: ContactCard) {
  return Object.values(c.organizations ?? {})[0] ?? null;
}

function titleEntry(c: ContactCard) {
  return Object.values(c.titles ?? {})[0] ?? null;
}

function titleText(c: ContactCard): string | null {
  return titleEntry(c)?.name?.trim() || null;
}

function birthEntry(c: ContactCard) {
  return Object.values(c.anniversaries ?? {}).find((x) => x.kind === "birth") ?? null;
}

function birthText(c: ContactCard): string | null {
  const d = birthEntry(c)?.date;
  if (!d) return null;
  if (d.utc) return d.utc;
  if (d.year == null && d.month == null && d.day == null) return null;
  return [
    d.year ?? "????",
    String(d.month ?? 0).padStart(2, "0"),
    String(d.day ?? 0).padStart(2, "0"),
  ].join("-");
}

function linkEntry(c: ContactCard) {
  return Object.values(c.links ?? {})[0] ?? null;
}

function websiteText(c: ContactCard): string | null {
  return linkEntry(c)?.uri ?? null;
}

function noteEntry(c: ContactCard) {
  return Object.values(c.notes ?? {})[0] ?? null;
}

function noteText(c: ContactCard): string | null {
  return noteEntry(c)?.note?.trim() || null;
}

function photoEntry(c: ContactCard) {
  return Object.values(c.media ?? {}).find((m) => m.kind === "photo") ?? null;
}

function photoText(c: ContactCard): string | null {
  const m = photoEntry(c);
  if (!m) return null;
  return m.uri ?? (m.blobId ? `blob:${m.blobId}` : "photo");
}

const FIELDS: ReadonlyArray<{
  id: MergeFieldId;
  label: string;
  read(c: ContactCard): string | null;
}> = [
  { id: "kind", label: "Type", read: kindText },
  { id: "name", label: "Name", read: nameText },
  { id: "nickname", label: "Nickname", read: nicknameText },
  { id: "company", label: "Company", read: companyText },
  { id: "jobTitle", label: "Job title", read: titleText },
  { id: "birthday", label: "Birthday", read: birthText },
  { id: "website", label: "Website", read: websiteText },
  { id: "note", label: "Note", read: noteText },
  { id: "photo", label: "Photo", read: photoText },
];

/**
 * The one-slot fields the two cards disagree on, each with both values for the
 * reader to choose between. A field only one of them holds is not a conflict —
 * there is nothing to choose — and neither is a field they agree on.
 */
export function contactMergeConflicts(a: ContactCard, b: ContactCard): MergeConflict[] {
  const out: MergeConflict[] = [];
  for (const field of FIELDS) {
    const left = field.read(a);
    const right = field.read(b);
    if (left && right && left !== right)
      out.push({ id: field.id, label: field.label, a: left, b: right });
  }
  return out;
}

/** Every key the merge decides itself; anything else is carried over. */
const HANDLED = new Set([
  "id",
  "uid",
  "@type",
  "version",
  "addressBookIds",
  "created",
  "updated",
  "kind",
  "name",
  "nicknames",
  "organizations",
  "titles",
  "notes",
  "anniversaries",
  "links",
  "media",
  "emails",
  "phones",
  "addresses",
  "onlineServices",
  "personalInfo",
  "calendars",
  "schedulingAddresses",
  "preferredLanguages",
  "members",
  "keywords",
  "relatedTo",
]);

function putEntry<T>(out: Record<string, T>, prefix: string, value: T): void {
  let key = newKey(prefix);
  while (key in out) key = newKey(prefix);
  out[key] = value;
}

/**
 * An entry whose key is not an identity — two lists of emails union by value.
 * The same rule as `mergeEntries` with no side losing an entry, which is what a
 * field the reader was asked nothing about is.
 */
function unionByValue<T>(
  a: Record<string, T> | null | undefined,
  b: Record<string, T> | null | undefined,
): Record<string, T> | null {
  return mergeEntries(a, b, null, null, null);
}

/** An entry whose key *is* the identity — members and keywords. */
function unionByKey<T>(
  a: Record<string, T> | null | undefined,
  b: Record<string, T> | null | undefined,
): Record<string, T> | null {
  const out: Record<string, T> = { ...(a ?? {}), ...(b ?? {}) };
  return Object.keys(out).length ? out : null;
}

/**
 * Merge a map whose first entry the reader may have chosen between.
 *
 * Every entry of both sides is kept, deduped by its whole value (so two links of
 * one URI but different labels stay two, and a link with no URI is not written
 * twice), except **one** entry: the losing side's entry the choice was between.
 * Keys are preserved where they do not collide, so an untouched card's entries
 * keep their own keys. A field only one side holds has no competing entry, so it
 * is a plain union — which is `side: null`, and what `unionByValue` is.
 *
 * "The same value" is order-insensitive (`stableJson`): the same entry spelled
 * with its keys in another order is one entry, not two.
 */
function mergeEntries<T>(
  a: Record<string, T> | null | undefined,
  b: Record<string, T> | null | undefined,
  side: MergeSide | null,
  slotA: T | null,
  slotB: T | null,
): Record<string, T> | null {
  const loseFromA = side === "b";
  const loseFromB = side === "a";
  const loseSig =
    loseFromA && slotA
      ? stableJson(slotA)
      : loseFromB && slotB
        ? stableJson(slotB)
        : null;
  const out: Record<string, T> = {};
  const seen = new Set<string>();
  for (const [source, isLoser] of [
    [a, loseFromA],
    [b, loseFromB],
  ] as Array<[Record<string, T> | null | undefined, boolean]>) {
    let dropped = false;
    for (const [key, entry] of Object.entries(source ?? {})) {
      const sig = stableJson(entry);
      // The one entry the choice was between, on the side that lost it.
      if (isLoser && !dropped && loseSig !== null && sig === loseSig) {
        dropped = true;
        continue;
      }
      if (seen.has(sig)) continue;
      seen.add(sig);
      // A new key keeps the colliding key's own first character, so a merged
      // entry reads like one the editor wrote for that field.
      if (key in out) putEntry(out, key.slice(0, 1) || "k", entry);
      else out[key] = entry;
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Relationships, unioned by the related uid. A uid both cards relate to keeps
 * both sets of relations rather than the surviving card's replacing the other's:
 * "colleague" from one card and "friend" from the other are not in conflict.
 */
function mergeRelations(a: ContactCard, b: ContactCard): ContactCard["relatedTo"] | null {
  const out: NonNullable<ContactCard["relatedTo"]> = {};
  for (const source of [a, b]) {
    for (const [uid, rel] of Object.entries(source.relatedTo ?? {})) {
      const held = out[uid];
      if (!held) {
        out[uid] = rel;
        continue;
      }
      const relation = { ...(held.relation ?? {}), ...(rel.relation ?? {}) };
      out[uid] = {
        ...held,
        ...rel,
        ...(Object.keys(relation).length ? { relation } : {}),
      };
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The patch the surviving card is written with, from the two cards and the
 * reader's choices. `a` is the card that survives; every field it does not have
 * and `b` does comes over, and the one-slot fields take the side the reader
 * chose where the two disagreed.
 *
 * The **named** fields are written whole — a field neither card holds goes in as
 * `null` — so the merged card is what was planned rather than what a patch left
 * behind. A key the merge does not name is left to the survivor (see the
 * carry-over below), because the write is a patch: Stalwart applies what it is
 * sent and keeps what it is not. `addressBookIds` is the union of both: the two
 * cards are in one account by construction, so a book either was filed in is kept.
 */
export function mergeContactCards(
  a: ContactCard,
  b: ContactCard,
  picks: Partial<Record<MergeFieldId, MergeSide>> = {},
): Record<string, unknown> {
  const side = (id: MergeFieldId, aHas: boolean, bHas: boolean): MergeSide | null => {
    if (aHas && bHas) return picks[id] ?? "a";
    if (aHas) return "a";
    if (bHas) return "b";
    return null;
  };
  /**
   * The side a map's competing entry comes from, and only when the two values
   * actually disagree. A field only one side holds has nothing to drop, and two
   * equal values are not a conflict — dropping a side then would lose the other
   * side's differing entry body (same URI, other label) without ever asking.
   */
  const conflictSide = (
    id: MergeFieldId,
    left: string | null,
    right: string | null,
  ): MergeSide | null => (left && right && left !== right ? (picks[id] ?? "a") : null);
  const choose = <T>(
    id: MergeFieldId,
    aHas: boolean,
    av: T | null,
    bHas: boolean,
    bv: T | null,
  ): T | null => {
    const from = side(id, aHas, bHas);
    if (from === "a") return av;
    if (from === "b") return bv;
    return null;
  };

  const out: Record<string, unknown> = {};
  out.kind =
    (side("kind", true, true) ?? "a") === "a"
      ? (a.kind ?? "individual")
      : (b.kind ?? "individual");
  out.name = choose(
    "name",
    nameText(a) != null,
    a.name ?? null,
    nameText(b) != null,
    b.name ?? null,
  );
  out.nicknames = mergeEntries(
    a.nicknames,
    b.nicknames,
    conflictSide("nickname", nicknameText(a), nicknameText(b)),
    nicknameEntry(a),
    nicknameEntry(b),
  );
  out.organizations = mergeEntries(
    a.organizations,
    b.organizations,
    conflictSide("company", companyText(a), companyText(b)),
    organizationEntry(a),
    organizationEntry(b),
  );
  out.titles = mergeEntries(
    a.titles,
    b.titles,
    conflictSide("jobTitle", titleText(a), titleText(b)),
    titleEntry(a),
    titleEntry(b),
  );
  out.notes = mergeEntries(
    a.notes,
    b.notes,
    conflictSide("note", noteText(a), noteText(b)),
    noteEntry(a),
    noteEntry(b),
  );
  out.anniversaries = mergeEntries(
    a.anniversaries,
    b.anniversaries,
    conflictSide("birthday", birthText(a), birthText(b)),
    birthEntry(a),
    birthEntry(b),
  );
  out.links = mergeEntries(
    a.links,
    b.links,
    conflictSide("website", websiteText(a), websiteText(b)),
    linkEntry(a),
    linkEntry(b),
  );
  out.media = mergeEntries(
    a.media,
    b.media,
    conflictSide("photo", photoText(a), photoText(b)),
    photoEntry(a),
    photoEntry(b),
  );

  out.emails = unionByValue(a.emails, b.emails);
  out.phones = unionByValue(a.phones, b.phones);
  out.addresses = unionByValue(a.addresses, b.addresses);
  out.onlineServices = unionByValue(a.onlineServices, b.onlineServices);
  out.personalInfo = unionByValue(a.personalInfo, b.personalInfo);
  out.calendars = unionByValue(a.calendars, b.calendars);
  out.schedulingAddresses = unionByValue(a.schedulingAddresses, b.schedulingAddresses);
  out.preferredLanguages = unionByValue(a.preferredLanguages, b.preferredLanguages);
  out.members = unionByKey(a.members, b.members);
  out.keywords = unionByKey(a.keywords, b.keywords);
  out.relatedTo = mergeRelations(a, b);
  out.addressBookIds = unionByKey(a.addressBookIds, b.addressBookIds);

  /*
   * Everything the merge does not name itself, and that only the absorbed card
   * holds, is carried over. A key **both** cards hold is left to the survivor on
   * purpose: an unknown key may be a structured object (`speakToAs`) rather than
   * an id-to-entry map, and unioning its members would corrupt it. Nothing named
   * by the merge is reached here -- those keys are handled above.
   */
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (HANDLED.has(key)) continue;
    const av = (a as unknown as Record<string, unknown>)[key];
    const bv = (b as unknown as Record<string, unknown>)[key];
    if (av === undefined && bv !== undefined) out[key] = bv;
  }

  return out;
}

/**
 * The two items a merge acts on, in the order they were selected: the one ticked
 * first survives, so this answers `[survivor, absorbed]` from the ticked items
 * and the keys in the order they were ticked.
 *
 * An item whose key is not in `order` refuses the merge rather than being sorted
 * last, because letting the list's order decide would silently invert "the one
 * ticked first survives". Anything other than exactly two ticked items is not a
 * merge either.
 */
export function mergeSelection<T>(
  items: T[],
  keyOf: (item: T) => string,
  order: string[],
): [T, T] | null {
  if (items.length !== 2) return null;
  const [first, second] = [...items].sort(
    (x, y) => order.indexOf(keyOf(x)) - order.indexOf(keyOf(y)),
  );
  if (order.indexOf(keyOf(first!)) < 0 || order.indexOf(keyOf(second!)) < 0) return null;
  return [first!, second!];
}
