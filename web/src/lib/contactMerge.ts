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

function nicknameText(c: ContactCard): string | null {
  return Object.values(c.nicknames ?? {})[0]?.name?.trim() || null;
}

function companyText(c: ContactCard): string | null {
  return contactCompany(c) ?? null;
}

function titleText(c: ContactCard): string | null {
  return Object.values(c.titles ?? {})[0]?.name?.trim() || null;
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

function noteText(c: ContactCard): string | null {
  return Object.values(c.notes ?? {})[0]?.note?.trim() || null;
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

/** An entry whose key is not an identity — two lists of emails union by value. */
function unionByValue<T>(
  a: Record<string, T> | null | undefined,
  b: Record<string, T> | null | undefined,
): Record<string, T> | null {
  const out: Record<string, T> = {};
  const seen = new Set<string>();
  for (const source of [a, b]) {
    for (const [key, entry] of Object.entries(source ?? {})) {
      const signature = JSON.stringify(entry);
      if (seen.has(signature)) continue;
      seen.add(signature);
      if (key in out) putEntry(out, key.slice(0, 1) || "k", entry);
      else out[key] = entry;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** An entry whose key *is* the identity — members, keywords, relationships. */
function unionByKey<T>(
  a: Record<string, T> | null | undefined,
  b: Record<string, T> | null | undefined,
): Record<string, T> | null {
  const out: Record<string, T> = { ...(a ?? {}), ...(b ?? {}) };
  return Object.keys(out).length ? out : null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mergeLinks(
  a: ContactCard,
  b: ContactCard,
  side: MergeSide | null,
): NonNullable<ContactCard["links"]> | null {
  const chosen =
    side === "b"
      ? linkEntry(b)
      : side === "a"
        ? linkEntry(a)
        : (linkEntry(a) ?? linkEntry(b));
  const out: NonNullable<ContactCard["links"]> = {};
  const seen = new Set<string>();
  if (chosen) {
    putEntry(out, "l", chosen);
    if (chosen.uri) seen.add(chosen.uri);
  }
  for (const source of [a, b])
    for (const link of Object.values(source.links ?? {})) {
      if (link.uri && seen.has(link.uri)) continue;
      if (link.uri) seen.add(link.uri);
      putEntry(out, "l", link);
    }
  return Object.keys(out).length ? out : null;
}

function mergeAnniversaries(
  a: ContactCard,
  b: ContactCard,
  side: MergeSide | null,
): NonNullable<ContactCard["anniversaries"]> | null {
  const chosen =
    side === "b"
      ? birthEntry(b)
      : side === "a"
        ? birthEntry(a)
        : (birthEntry(a) ?? birthEntry(b));
  const out: NonNullable<ContactCard["anniversaries"]> = {};
  const seen = new Set<string>();
  if (chosen) {
    putEntry(out, "a", chosen);
    seen.add(JSON.stringify(chosen));
  }
  for (const source of [a, b])
    for (const an of Object.values(source.anniversaries ?? {})) {
      if (an.kind === "birth") continue;
      const signature = JSON.stringify(an);
      if (seen.has(signature)) continue;
      seen.add(signature);
      putEntry(out, "a", an);
    }
  return Object.keys(out).length ? out : null;
}

function mergeMedia(
  a: ContactCard,
  b: ContactCard,
  side: MergeSide | null,
): NonNullable<ContactCard["media"]> | null {
  const chosen =
    side === "b"
      ? photoEntry(b)
      : side === "a"
        ? photoEntry(a)
        : (photoEntry(a) ?? photoEntry(b));
  const out: NonNullable<ContactCard["media"]> = {};
  const seen = new Set<string>();
  if (chosen) {
    putEntry(out, "p", chosen);
    seen.add(JSON.stringify(chosen));
  }
  for (const source of [a, b])
    for (const m of Object.values(source.media ?? {})) {
      if (m.kind === "photo") continue;
      const signature = JSON.stringify(m);
      if (seen.has(signature)) continue;
      seen.add(signature);
      putEntry(out, "m", m);
    }
  return Object.keys(out).length ? out : null;
}

/**
 * The patch the surviving card is written with, from the two cards and the
 * reader's choices. `a` is the card that survives; every field it does not have
 * and `b` does comes over, and the one-slot fields take the side the reader
 * chose where the two disagreed.
 *
 * The patch is written whole — a field neither card holds goes in as `null` — so
 * the merged card is exactly what was planned rather than what a patch left
 * behind on the server.
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
  out.nicknames = choose(
    "nickname",
    nicknameText(a) != null,
    a.nicknames ?? null,
    nicknameText(b) != null,
    b.nicknames ?? null,
  );
  out.organizations = choose(
    "company",
    companyText(a) != null,
    a.organizations ?? null,
    companyText(b) != null,
    b.organizations ?? null,
  );
  out.titles = choose(
    "jobTitle",
    titleText(a) != null,
    a.titles ?? null,
    titleText(b) != null,
    b.titles ?? null,
  );
  out.notes = choose(
    "note",
    noteText(a) != null,
    a.notes ?? null,
    noteText(b) != null,
    b.notes ?? null,
  );

  out.anniversaries = mergeAnniversaries(
    a,
    b,
    side("birthday", birthText(a) != null, birthText(b) != null),
  );
  out.links = mergeLinks(
    a,
    b,
    side("website", websiteText(a) != null, websiteText(b) != null),
  );
  out.media = mergeMedia(a, b, side("photo", photoText(a) != null, photoText(b) != null));

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
  out.relatedTo = unionByKey(a.relatedTo, b.relatedTo);

  /*
   * Everything the merge does not name itself, carried over rather than dropped:
   * a field only one card holds is a non-conflicting field, and the whole point
   * of a merge is that nothing either card knew is lost.
   */
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (HANDLED.has(key)) continue;
    const av = (a as unknown as Record<string, unknown>)[key];
    const bv = (b as unknown as Record<string, unknown>)[key];
    if (av === undefined) out[key] = bv;
    else if (isPlainObject(av) && isPlainObject(bv)) out[key] = unionByValue(av, bv);
  }

  return out;
}
