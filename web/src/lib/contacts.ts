import { GLOBAL_CONTACTS_BOOK_NAME } from "@gilbert/shared/phone";
import type {
  AddressBook,
  ContactCard,
  EmailAddress,
  JSContactMedia,
  JSContactName,
} from "@/jmap/types";
import { withBase } from "@/lib/basePath";
import { foldLine } from "./contentLines";

/**
 * Whether an address book is the installation's shared Global contacts
 * directory (ADR 0023). One predicate, asked by the sidebar and the dialer, so
 * the two cannot disagree about which book is the directory.
 */
export function isGlobalContactsBook(book: Pick<AddressBook, "name">): boolean {
  return book.name === GLOBAL_CONTACTS_BOOK_NAME;
}

/** Best display name for a card. */
export function contactDisplayName(c: ContactCard): string {
  const n = c.name;
  if (n?.full?.trim()) return n.full.trim();
  const comps = n?.components ?? [];
  const ordered = comps.filter((x) =>
    ["given", "given2", "surname", "surname2"].includes(x.kind),
  );
  if (ordered.length) {
    // Prefer given + surname order regardless of isOrdered for display.
    const given = comps
      .filter((x) => x.kind === "given" || x.kind === "given2")
      .map((x) => x.value)
      .join(" ");
    const sur = comps
      .filter((x) => x.kind === "surname" || x.kind === "surname2")
      .map((x) => x.value)
      .join(" ");
    const s = `${given} ${sur}`.trim();
    if (s) return s;
  }
  if (c.kind === "group" || c.kind === "org") {
    const org = contactCompany(c);
    if (org) return org;
  }
  const nick = Object.values(c.nicknames ?? {})[0]?.name;
  if (nick) return nick;
  const org = contactCompany(c);
  if (org) return org;
  const email = primaryEmail(c);
  if (email) return email;
  return "(no name)";
}

/**
 * The company a card belongs to, where it carries one.
 *
 * One accessor for the first organisation, because the company is read by
 * several surfaces and a second spelling of where it lives is how two of them
 * come to read two different fields: the list shows it beside a person's name,
 * the detail pane and the editor read it as a field of its own, and the
 * birthdays feed falls back to it as a name.
 */
export function contactCompany(c: ContactCard): string | undefined {
  return Object.values(c.organizations ?? {})[0]?.name?.trim() || undefined;
}

export function nameParts(c: ContactCard): {
  given: string;
  surname: string;
  prefix: string;
  suffix: string;
  middle: string;
} {
  const comps = c.name?.components ?? [];
  const pick = (k: string) =>
    comps
      .filter((x) => x.kind === k)
      .map((x) => x.value)
      .join(" ");
  return {
    given: pick("given"),
    middle: pick("given2"),
    surname: pick("surname"),
    prefix: pick("title"),
    suffix: pick("credential") || pick("generation"),
  };
}

export function buildName(parts: {
  given?: string;
  middle?: string;
  surname?: string;
  prefix?: string;
  suffix?: string;
}): JSContactName | undefined {
  const components: JSContactName["components"] = [];
  if (parts.prefix?.trim())
    components.push({
      "@type": "NameComponent",
      kind: "title",
      value: parts.prefix.trim(),
    });
  if (parts.given?.trim())
    components.push({
      "@type": "NameComponent",
      kind: "given",
      value: parts.given.trim(),
    });
  if (parts.middle?.trim())
    components.push({
      "@type": "NameComponent",
      kind: "given2",
      value: parts.middle.trim(),
    });
  if (parts.surname?.trim())
    components.push({
      "@type": "NameComponent",
      kind: "surname",
      value: parts.surname.trim(),
    });
  if (parts.suffix?.trim())
    components.push({
      "@type": "NameComponent",
      kind: "credential",
      value: parts.suffix.trim(),
    });
  if (!components.length) return undefined;
  const full = [parts.prefix, parts.given, parts.middle, parts.surname, parts.suffix]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(" ");
  return { "@type": "Name", components, isOrdered: true, full };
}

export function primaryEmail(c: ContactCard): string | null {
  const emails = Object.values(c.emails ?? {});
  if (!emails.length) return null;
  const sorted = [...emails].sort((a, b) => (a.pref ?? 100) - (b.pref ?? 100));
  return sorted[0]!.address;
}

export function contactEmails(c: ContactCard): EmailAddress[] {
  const name = contactDisplayName(c);
  return Object.values(c.emails ?? {}).map((e) => ({
    name: name.includes("@") ? null : name,
    email: e.address,
  }));
}

/**
 * The addresses a group stands for (ADR 0004).
 *
 * A group is a name for a set of people who are already cards: `members`
 * names them by `uid`, and a uid means nothing outside the account that holds
 * it — so `cards` is that account's cards, which the caller has (`cardsIn`).
 *
 * One address per member, the preferred one: a card carrying two addresses is
 * one person, and a group must not send them two copies. A member that is not
 * there, carries no address, or is itself a group is skipped and counted,
 * because the reader is owed the number of people left out of what they asked
 * for. Nesting is ignored rather than followed: the editor cannot make a group
 * a member of a group, and a server that returned one would otherwise be a
 * licence to recurse.
 */
export function groupRecipients(
  group: ContactCard,
  cards: readonly ContactCard[],
): { addresses: EmailAddress[]; skipped: number } {
  const byUid = cardsByUid(cards);
  const addresses: EmailAddress[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const uid of Object.keys(group.members ?? {})) {
    const member = byUid.get(uid);
    const address = member && member.kind !== "group" ? primaryEmail(member) : null;
    if (!member || member.kind === "group" || !address) {
      skipped += 1;
      continue;
    }
    const key = address.toLowerCase();
    // Two cards for one person: the same recipient, once.
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push({ name: contactDisplayName(member), email: address });
  }
  return { addresses, skipped };
}

/** A card list keyed by uid, built in one pass. */
export function cardsByUid(cards: readonly ContactCard[]): Map<string, ContactCard> {
  const byUid = new Map<string, ContactCard>();
  for (const c of cards) if (c.uid) byUid.set(c.uid, c);
  return byUid;
}

/**
 * The cards a group's member uids name, from the account's list read once.
 *
 * A member is stored as a uid, and a uid means nothing outside the account
 * holding the card, so the lookup has to happen in that account's list. What it
 * must not do is read that list again for every member: a group with many
 * members then costs members × cards to draw.
 */
export function memberCards(
  cards: readonly ContactCard[],
  members: Record<string, unknown> | null | undefined,
): ContactCard[] {
  const byUid = cardsByUid(cards);
  const out: ContactCard[] = [];
  for (const uid of Object.keys(members ?? {})) {
    const c = byUid.get(uid);
    if (c) out.push(c);
  }
  return out;
}

/**
 * A card's `media` with its photo replaced by `photo`, or removed when that is
 * null, and everything else in it -- a logo, a sound -- left as it was.
 *
 * The photo goes in as a `data:` URI. Stalwart refuses a `blobId` in `media`
 * outright -- "blobIds in media is not supported", `invalidProperties` on
 * `media`, which takes the whole `ContactCard/set` down with it -- though
 * RFC 9610 lets JMAP put one there and the RFC 9553 `uri` form is accepted and
 * returned unchanged. Confirmed live on 0.16.22 (2026-09-16); a 134 KB data URI
 * was accepted, and the editor's photo is a 256px JPEG of a few tens of KB.
 * The mock refuses a `blobId` the same way, so this cannot come back.
 */
export function withPhoto(
  media: Record<string, JSContactMedia> | undefined | null,
  photo: { dataUrl: string; type: string } | null,
): Record<string, JSContactMedia> | null {
  const rest: Record<string, JSContactMedia> = Object.fromEntries(
    Object.entries(media ?? {}).filter(([, m]) => m.kind !== "photo"),
  );
  if (photo)
    rest[newKey("p")] = {
      "@type": "Media",
      kind: "photo",
      uri: photo.dataUrl,
      mediaType: photo.type,
    };
  return Object.keys(rest).length ? rest : null;
}

export function contactPhoto(c: ContactCard, accountId: string): string | null {
  const m = Object.values(c.media ?? {}).find((x) => x.kind === "photo");
  if (!m) return null;
  if (m.uri) return m.uri.startsWith("data:") ? m.uri : null;
  if (m.blobId)
    return withBase(
      `/api/blob/${encodeURIComponent(accountId)}/${encodeURIComponent(m.blobId)}/photo?accept=${encodeURIComponent(m.mediaType ?? "image/jpeg")}&inline=1`,
    );
  return null;
}

export function sortKey(c: ContactCard, by: "surname" | "given" = "given"): string {
  const p = nameParts(c);
  const k = by === "surname" ? `${p.surname} ${p.given}` : `${p.given} ${p.surname}`;
  return (k.trim() || contactDisplayName(c)).toLowerCase();
}

export function formatAddressLines(a: {
  components?: Array<{ kind: string; value: string }>;
  full?: string;
}): string[] {
  if (a.full) return a.full.split(/\n/);
  const get = (k: string) =>
    (a.components ?? [])
      .filter((c) => c.kind === k)
      .map((c) => c.value)
      .join(" ");
  const lines: string[] = [];
  const street = [
    get("number"),
    get("name"),
    get("apartment"),
    get("building"),
    get("floor"),
    get("room"),
  ]
    .filter(Boolean)
    .join(" ");
  const pobox = get("postOfficeBox");
  if (pobox) lines.push(pobox);
  if (street) lines.push(street);
  const city = [get("locality"), get("region")].filter(Boolean).join(", ");
  const cityLine = [city, get("postcode")].filter(Boolean).join(" ");
  if (cityLine) lines.push(cityLine);
  if (get("country")) lines.push(get("country"));
  return lines;
}

/** Generate a vCard 4.0 for export. */
export function toVCard(c: ContactCard): string {
  const esc = (s: string) =>
    s
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\n/g, "\\n");
  const lines = ["BEGIN:VCARD", "VERSION:4.0"];
  lines.push(`UID:${c.uid}`);
  if (c.kind && c.kind !== "individual") lines.push(`KIND:${c.kind}`);
  lines.push(`FN:${esc(contactDisplayName(c))}`);
  const p = nameParts(c);
  if (p.given || p.surname)
    lines.push(
      `N:${esc(p.surname)};${esc(p.given)};${esc(p.middle)};${esc(p.prefix)};${esc(p.suffix)}`,
    );
  for (const n of Object.values(c.nicknames ?? {})) lines.push(`NICKNAME:${esc(n.name)}`);
  for (const e of Object.values(c.emails ?? {})) {
    const types = Object.keys(e.contexts ?? {}).join(",");
    lines.push(
      `EMAIL${types ? `;TYPE=${types}` : ""}${e.pref ? `;PREF=${e.pref}` : ""}:${e.address}`,
    );
  }
  for (const ph of Object.values(c.phones ?? {})) {
    const types = [
      ...Object.keys(ph.contexts ?? {}),
      ...Object.keys(ph.features ?? {}),
    ].join(",");
    lines.push(
      `TEL${types ? `;TYPE=${types}` : ""}${ph.pref ? `;PREF=${ph.pref}` : ""}:${ph.number}`,
    );
  }
  for (const a of Object.values(c.addresses ?? {})) {
    const get = (k: string) =>
      (a.components ?? [])
        .filter((x) => x.kind === k)
        .map((x) => x.value)
        .join(" ");
    const street = [get("number"), get("name"), get("apartment")]
      .filter(Boolean)
      .join(" ");
    const types = Object.keys(a.contexts ?? {}).join(",");
    lines.push(
      `ADR${types ? `;TYPE=${types}` : ""}:${esc(get("postOfficeBox"))};;${esc(street)};${esc(get("locality"))};${esc(get("region"))};${esc(get("postcode"))};${esc(get("country"))}`,
    );
  }
  for (const o of Object.values(c.organizations ?? {}))
    lines.push(
      `ORG:${esc(o.name ?? "")}${(o.units ?? []).map((u) => `;${esc(u.name)}`).join("")}`,
    );
  for (const t of Object.values(c.titles ?? {}))
    lines.push(`${t.kind === "role" ? "ROLE" : "TITLE"}:${esc(t.name)}`);
  for (const an of Object.values(c.anniversaries ?? {})) {
    const d = an.date;
    const v = d.utc
      ? d.utc.slice(0, 10).replace(/-/g, "")
      : `${d.year ?? "--"}${String(d.month ?? 0).padStart(2, "0")}${String(d.day ?? 0).padStart(2, "0")}`;
    if (an.kind === "birth") lines.push(`BDAY:${v}`);
    else if (an.kind === "wedding") lines.push(`ANNIVERSARY:${v}`);
  }
  for (const n of Object.values(c.notes ?? {})) lines.push(`NOTE:${esc(n.note)}`);
  for (const l of Object.values(c.links ?? {})) lines.push(`URL:${l.uri}`);
  for (const s of Object.values(c.onlineServices ?? {}))
    if (s.uri) lines.push(`IMPP:${s.uri}`);
  if (c.members) for (const m of Object.keys(c.members)) lines.push(`MEMBER:${m}`);
  lines.push("END:VCARD");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

export function newKey(prefix = "k"): string {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A new contact card seeded from an email address.
 *
 * The display name in a From header is one string, so it has to be split into
 * name components: "Ada Lovelace" gives given + surname, the "Lovelace, Ada"
 * form is unpicked, and a single word becomes the given name. Anything that
 * looks like an address rather than a name is left out — a card named
 * "ada@example.org" helps nobody.
 */
export function contactFromAddress(addr: EmailAddress): Partial<ContactCard> {
  const card: Partial<ContactCard> = {
    kind: "individual",
    emails: { [newKey("e")]: { "@type": "EmailAddress", address: addr.email, pref: 1 } },
  };
  const raw = (addr.name ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
  if (!raw || raw.includes("@")) return card;
  const [surnameFirst, givenRest] = raw.includes(",") ? raw.split(",", 2) : [];
  const parts =
    surnameFirst && givenRest
      ? { given: givenRest.trim(), surname: surnameFirst.trim() }
      : splitName(raw);
  const name = buildName(parts);
  if (name) card.name = name;
  return card;
}

function splitName(full: string): { given: string; middle: string; surname: string } {
  const words = full.split(/\s+/).filter(Boolean);
  if (words.length === 1) return { given: words[0]!, middle: "", surname: "" };
  return {
    given: words[0]!,
    middle: words.slice(1, -1).join(" "),
    surname: words[words.length - 1]!,
  };
}
