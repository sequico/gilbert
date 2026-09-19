import { Camera, Plus, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { client } from "@/jmap/client";
import type {
  ContactCard,
  JSContactAddress,
  JSContactEmail,
  JSContactPhone,
} from "@/jmap/types";
import {
  buildName,
  cardsByUid,
  contactCompany,
  contactDisplayName,
  nameParts,
  newKey,
  withPhoto,
} from "@/lib/contacts";
import { t } from "@/lib/i18n";
import { isGroupMailboxAccount } from "@/lib/mailAccounts";
import { sharedKey, useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { useSettings } from "@/store/settings";
import { DateField } from "@/ui/datefield";
import { Dialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";

interface Props {
  card: Partial<ContactCard>;
  defaultBookId: string | null;
  /** The account that holds `card`; null while creating a new card. */
  sourceAccountId: string | null;
  /** The account a brand-new card defaults into (the book being viewed). */
  defaultAccountId: string | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}

const EMAIL_CTX = ["private", "work", "other"];
const PHONE_CTX = ["mobile", "private", "work", "fax", "other"];
const ADDR_CTX = ["private", "work", "other"];

type EmailRow = { key: string; address: string; ctx: string };
type PhoneRow = { key: string; number: string; ctx: string };
type AddrRow = {
  key: string;
  ctx: string;
  street: string;
  city: string;
  region: string;
  postcode: string;
  country: string;
};

export function ContactEditor({
  card,
  defaultBookId,
  sourceAccountId,
  defaultAccountId,
  onClose,
  onSaved,
}: Props) {
  const contacts = useContacts();
  const isNew = !card.id; // Read from the card whether it is saved or seeded (e.g. from a message header).
  const np = nameParts(card as ContactCard);
  const [kind, setKind] = useState<"individual" | "group" | "org">(
    (card.kind as "individual" | "group" | "org") ?? "individual",
  );
  const [given, setGiven] = useState(np.given);
  const [surname, setSurname] = useState(np.surname);
  const [prefix, setPrefix] = useState(np.prefix);
  const [middle, setMiddle] = useState(np.middle);
  const [suffix, setSuffix] = useState(np.suffix);
  const [nickname, setNickname] = useState(
    Object.values(card.nicknames ?? {})[0]?.name ?? "",
  );
  const [company, setCompany] = useState(contactCompany(card as ContactCard) ?? "");
  const [jobTitle, setJobTitle] = useState(
    Object.values(card.titles ?? {})[0]?.name ?? "",
  );
  const [emails, setEmails] = useState<EmailRow[]>(() =>
    Object.entries(card.emails ?? {}).map(([key, e]) => ({
      key,
      address: e.address,
      ctx: Object.keys(e.contexts ?? {})[0] ?? "other",
    })),
  );
  const [phones, setPhones] = useState<PhoneRow[]>(() =>
    Object.entries(card.phones ?? {}).map(([key, p]) => ({
      key,
      number: p.number,
      ctx:
        Object.keys(p.features ?? {})[0] ?? Object.keys(p.contexts ?? {})[0] ?? "other",
    })),
  );
  const [addrs, setAddrs] = useState<AddrRow[]>(() =>
    Object.entries(card.addresses ?? {}).map(([key, a]) => {
      const get = (k: string) =>
        (a.components ?? [])
          .filter((c) => c.kind === k)
          .map((c) => c.value)
          .join(" ");
      return {
        key,
        ctx: Object.keys(a.contexts ?? {})[0] ?? "other",
        street:
          [get("number"), get("name"), get("apartment")].filter(Boolean).join(" ") ||
          (a.full ?? ""),
        city: get("locality"),
        region: get("region"),
        postcode: get("postcode"),
        country: get("country"),
      };
    }),
  );
  const [birthday, setBirthday] = useState(() => {
    const b = Object.values(card.anniversaries ?? {}).find(
      (a) => a.kind === "birth",
    )?.date;
    return b?.year && b.month && b.day
      ? `${b.year}-${String(b.month).padStart(2, "0")}-${String(b.day).padStart(2, "0")}`
      : "";
  });
  const [website, setWebsite] = useState(Object.values(card.links ?? {})[0]?.uri ?? "");
  const [note, setNote] = useState(Object.values(card.notes ?? {})[0]?.note ?? "");
  /*
   * The target book, qualified by the account that holds it. A bare id is
   * ambiguous: an own book and a shared book can carry the same id in their
   * different accounts, and a bare id resolves to the reader's own -- so
   * choosing a shared book would silently save into the own one.
   */
  const [bookSel, setBookSel] = useState<{ accountId: string; bookId: string }>(() => {
    const own = contacts.accountId ?? "";
    const firstId = Object.keys(card.addressBookIds ?? {})[0];
    const accountId =
      firstId || !isNew ? (sourceAccountId ?? own) : (defaultAccountId ?? own);
    const bookId =
      firstId ??
      defaultBookId ??
      (!firstId && accountId === own ? (Object.values(contacts.books)[0]?.id ?? "") : "");
    return { accountId: accountId || own, bookId };
  });
  /*
   * A group is a set of people, not a person: its entry in a book has a name
   * and members, and the fields that describe a human being -- email, phone,
   * post and birthday, a website -- are not for it. They are neither offered
   * here nor written, wherever the entry is filed.
   */
  const personal = kind !== "group";
  const [photo, setPhoto] = useState<{ dataUrl: string; type: string } | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [memberUids, setMemberUids] = useState<string[]>(Object.keys(card.members ?? {}));
  const [memberQuery, setMemberQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const own = contacts.accountId ?? "";
  /* The mail store's probe is the one classifier for what is a group, read as
     state so a book appears when it lands. */
  const mailAccounts = useMail((s) => s.mailAccounts);
  const books = [
    ...Object.values(contacts.books).map((b) => ({
      accountId: own,
      id: b.id,
      name: b.name,
      note: "",
    })),
    /* Books the reader may write to and may reach without adding them: a book
       somebody shared, and a group's own directory. A group's book needs no
       subscribing -- membership of the group is the subscription, the rule the
       sidebar, `loadShared` and the composer's suggestions all follow.

       Leaving the group out of this list did not keep a card out of the group:
       the target comes from the book being browsed, so a card was filed into a
       book the picker did not show -- and showed the reader's own book instead,
       because a `<select>` whose value matches no option falls back to the
       first one. A control that cannot name where the contact is going is worse
       than one that refuses. */
    ...contacts.sharedBooks
      .filter(
        (b) =>
          b.book.myRights.mayWrite &&
          (isGroupMailboxAccount(b.accountId, mailAccounts) ||
            b.book.isSubscribed ||
            useSettings
              .getState()
              .settings.addedShares.includes(sharedKey(b.accountId, b.book.id))),
      )
      .map((b) => ({
        accountId: b.accountId,
        id: b.book.id,
        name: b.book.name,
        note: b.accountName,
      })),
  ];
  const { accountId: bookAccount, bookId } = bookSel;
  const existingPhoto =
    card.id && contacts.accountId
      ? Object.values(card.media ?? {}).find((m) => m.kind === "photo")
      : undefined;

  /*
   * Who can be a member of this card, which is a question about the account
   * the card is being filed into.
   *
   * A group's members are its own cards: the uid a member is stored as means
   * nothing in another account, and a group card filed in the group's book
   * refers to the group's book. Searching the reader's own cards there found
   * nobody -- the group's directory was not in the list to pick from -- while
   * searching them for a card of the reader's own is exactly right. So the
   * search follows the book chosen above, and follows it when that changes.
   */
  const memberCandidates = useMemo(() => {
    if (!memberQuery.trim()) return [];
    return contacts
      .filterCards(contacts.cardsIn(bookAccount), memberQuery)
      .filter((c) => c.kind !== "group" && !memberUids.includes(c.uid))
      .slice(0, 6);
    // Read off the card lists themselves rather than the whole store object: a
    // write to anything else must not re-run a search over the book.
  }, [
    memberQuery,
    contacts.cards,
    contacts.sharedCards,
    contacts.accountId,
    memberUids,
    bookAccount,
  ]);

  /*
   * The member chips look a uid up in the book's cards. One table, built once:
   * a uid means nothing outside the account holding the card, so the card has
   * to be found in that account's list -- and reading that list per chip is
   * what made a group with many members cost members × cards to draw.
   */
  const bookCardsByUid = useMemo(
    () => (kind === "group" ? cardsByUid(contacts.cardsIn(bookAccount)) : null),
    [kind, contacts.cards, contacts.sharedCards, contacts.accountId, bookAccount],
  );

  const save = async () => {
    if (!bookId) {
      toast.error(t("Choose an address book"));
      return;
    }
    setBusy(true);
    try {
      const obj: Record<string, unknown> = {};
      obj.kind = kind;
      const name = buildName({ given, surname, middle, prefix, suffix });
      if (kind === "individual") obj.name = name ?? null;
      else {
        obj.name = company ? { "@type": "Name", full: company } : (name ?? null);
      }
      obj.nicknames = nickname
        ? { [newKey("n")]: { "@type": "Nickname", name: nickname } }
        : null;
      obj.organizations = company
        ? { [newKey("o")]: { "@type": "Organization", name: company } }
        : null;
      obj.titles = jobTitle
        ? { [newKey("t")]: { "@type": "Title", name: jobTitle, kind: "title" } }
        : null;
      if (personal) {
        const em: Record<string, JSContactEmail> = {};
        emails
          .filter((e) => e.address.trim())
          .forEach((e, i) => {
            em[e.key] = {
              "@type": "EmailAddress",
              address: e.address.trim(),
              contexts: e.ctx !== "other" ? { [e.ctx]: true } : undefined,
              pref: i === 0 ? 1 : undefined,
            };
          });
        obj.emails = Object.keys(em).length ? em : null;
        const ph: Record<string, JSContactPhone> = {};
        phones
          .filter((p) => p.number.trim())
          .forEach((p) => {
            ph[p.key] = {
              "@type": "Phone",
              number: p.number.trim(),
              ...(["mobile", "fax"].includes(p.ctx)
                ? { features: { [p.ctx === "mobile" ? "mobile" : "fax"]: true } }
                : p.ctx !== "other"
                  ? { contexts: { [p.ctx]: true } }
                  : {}),
            };
          });
        obj.phones = Object.keys(ph).length ? ph : null;
        const ad: Record<string, JSContactAddress> = {};
        addrs
          .filter((a) => a.street || a.city || a.country || a.postcode)
          .forEach((a) => {
            const components: JSContactAddress["components"] = [];
            if (a.street)
              components.push({
                "@type": "AddressComponent",
                kind: "name",
                value: a.street,
              });
            if (a.city)
              components.push({
                "@type": "AddressComponent",
                kind: "locality",
                value: a.city,
              });
            if (a.region)
              components.push({
                "@type": "AddressComponent",
                kind: "region",
                value: a.region,
              });
            if (a.postcode)
              components.push({
                "@type": "AddressComponent",
                kind: "postcode",
                value: a.postcode,
              });
            if (a.country)
              components.push({
                "@type": "AddressComponent",
                kind: "country",
                value: a.country,
              });
            ad[a.key] = {
              "@type": "Address",
              components,
              contexts: a.ctx !== "other" ? { [a.ctx]: true } : undefined,
            };
          });
        obj.addresses = Object.keys(ad).length ? ad : null;
        if (birthday) {
          const [y, m, d] = birthday.split("-").map(Number) as [number, number, number];
          obj.anniversaries = {
            [newKey("a")]: {
              "@type": "Anniversary",
              kind: "birth",
              date: { "@type": "PartialDate", year: y, month: m, day: d },
            },
          };
        } else obj.anniversaries = null;
        obj.links = website
          ? {
              [newKey("l")]: {
                "@type": "Link",
                uri: /^https?:/i.test(website) ? website : `https://${website}`,
              },
            }
          : null;
      }
      obj.notes = note.trim()
        ? { [newKey("x")]: { "@type": "Note", note: note.trim() } }
        : null;
      obj.members =
        kind === "group" && memberUids.length
          ? Object.fromEntries(memberUids.map((u) => [u, true]))
          : null;
      /*
       * Inline, not uploaded: Stalwart refuses a `blobId` in `media`, which
       * took the whole write down with it. See `withPhoto`.
       */
      if (photo) obj.media = withPhoto(card.media, photo);
      else if (removePhoto) obj.media = withPhoto(card.media, null);
      if (isNew) {
        const id = await contacts.createCard(
          obj as Partial<ContactCard>,
          bookId,
          bookAccount,
        );
        toast.success(t("Contact created"));
        onSaved(id);
      } else {
        const cardAccount = sourceAccountId ?? contacts.accountId ?? "";
        if (cardAccount === bookAccount) {
          // Same account: a patch that adds the target book.
          const patch: Record<string, unknown> = { ...obj };
          const curBook = Object.keys(card.addressBookIds ?? {})[0];
          if (curBook !== bookId) patch.addressBookIds = { [bookId]: true };
          if (!photo && !removePhoto) delete patch.media;
          await contacts.updateCard(card.id!, patch);
          toast.success(t("Contact saved"));
          onSaved(card.id!);
        } else {
          // A different account holds the target book: the card moves there
          // (create the copy in that account, destroy this one). The id
          // changes, so navigate to the new card. The form's object goes
          // along: the copy is the card as edited here, photo included -- a
          // copy made from the cached card would silently lose every edit
          // (the calendar move's own apply-then-re-file equivalent).
          const newId = await contacts.moveCardTo(
            card.id!,
            cardAccount,
            bookAccount,
            bookId,
            obj as Partial<ContactCard>,
          );
          toast.success(t("Contact moved"));
          onSaved(newId);
        }
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onPhoto = (f: File) => {
    const img = new Image();
    const url = URL.createObjectURL(f);
    img.onload = () => {
      const size = 256;
      const c = document.createElement("canvas");
      c.width = size;
      c.height = size;
      const ctx = c.getContext("2d")!;
      const s = Math.min(img.width, img.height);
      ctx.drawImage(
        img,
        (img.width - s) / 2,
        (img.height - s) / 2,
        s,
        s,
        0,
        0,
        size,
        size,
      );
      setPhoto({ dataUrl: c.toDataURL("image/jpeg", 0.85), type: "image/jpeg" });
      setRemovePhoto(false);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const photoSrc =
    photo?.dataUrl ??
    (!removePhoto && existingPhoto
      ? existingPhoto.uri?.startsWith("data:")
        ? existingPhoto.uri
        : existingPhoto.blobId
          ? client.downloadUrl(
              contacts.accountId!,
              existingPhoto.blobId,
              "photo",
              existingPhoto.mediaType ?? "image/jpeg",
              true,
            )
          : null
      : null);

  return (
    <Dialog
      open
      onClose={onClose}
      title={isNew ? "New contact" : `Edit ${contactDisplayName(card as ContactCard)}`}
      size="lg"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="contact-form">
        <div className="row" style={{ gap: 16, marginBottom: 12 }}>
          <label
            className="avatar xl"
            style={{
              background: "var(--bg-sunken)",
              color: "var(--fg-muted)",
              cursor: "pointer",
              position: "relative",
            }}
            title={t("Change photo")}
          >
            {photoSrc ? <img src={photoSrc} alt="" /> : <Camera size={28} />}
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onPhoto(f);
                e.target.value = "";
              }}
            />
          </label>
          {photoSrc && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setPhoto(null);
                setRemovePhoto(true);
              }}
            >
              <X size={14} /> {t("Remove photo")}
            </button>
          )}
          <span className="spacer" />
          <div className="field" style={{ marginBottom: 0, width: 160 }}>
            <label>{t("Type")}</label>
            <select
              className="select"
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <option value="individual">{t("Person")}</option>
              <option value="org">{t("Organization")}</option>
              <option value="group">{t("Group")}</option>
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0, width: 200 }}>
            <label>{t("Address book")}</label>
            <select
              className="select"
              value={`${bookAccount}\u0000${bookId}`}
              onChange={(e) => {
                const [acct, bid] = e.target.value.split("\u0000");
                setBookSel({ accountId: acct ?? bookAccount, bookId: bid ?? "" });
              }}
            >
              {books.map((b) => (
                <option
                  key={`${b.accountId}\u0000${b.id}`}
                  value={`${b.accountId}\u0000${b.id}`}
                >
                  {b.note ? `${b.name} · ${b.note}` : b.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {kind === "individual" ? (
          <>
            <div className="field-row">
              <div className="field">
                <label>{t("First name")}</label>
                <input
                  className="input"
                  value={given}
                  onChange={(e) => setGiven(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="field">
                <label>{t("Last name")}</label>
                <input
                  className="input"
                  value={surname}
                  onChange={(e) => setSurname(e.target.value)}
                />
              </div>
            </div>
            <details>
              <summary className="hint" style={{ cursor: "pointer", marginBottom: 8 }}>
                {t("More name fields")}
              </summary>
              <div className="field-row">
                <div className="field">
                  <label>{t("Prefix")}</label>
                  <input
                    className="input"
                    value={prefix}
                    onChange={(e) => setPrefix(e.target.value)}
                    placeholder={t("Dr.")}
                  />
                </div>
                <div className="field">
                  <label>{t("Middle name")}</label>
                  <input
                    className="input"
                    value={middle}
                    onChange={(e) => setMiddle(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label>{t("Suffix")}</label>
                  <input
                    className="input"
                    value={suffix}
                    onChange={(e) => setSuffix(e.target.value)}
                    placeholder={t("Jr.")}
                  />
                </div>
                <div className="field">
                  <label>{t("Nickname")}</label>
                  <input
                    className="input"
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                  />
                </div>
              </div>
            </details>
            <div className="field-row">
              <div className="field">
                <label>{t("Company")}</label>
                <input
                  className="input"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                />
              </div>
              <div className="field">
                <label>{t("Job title")}</label>
                <input
                  className="input"
                  value={jobTitle}
                  onChange={(e) => setJobTitle(e.target.value)}
                />
              </div>
            </div>
          </>
        ) : (
          <div className="field">
            <label>{kind === "group" ? "Group name" : "Organization name"}</label>
            <input
              className="input"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              autoFocus
            />
          </div>
        )}

        {kind === "group" && (
          <div className="field">
            <label>{t("Members")}</label>
            <div className="row wrap gap-4 mb-8">
              {memberUids.map((uid) => {
                const m = bookCardsByUid?.get(uid);
                return (
                  <span key={uid} className="chip">
                    {m ? contactDisplayName(m) : uid}
                    <button
                      className="chip-x"
                      onClick={() => setMemberUids(memberUids.filter((u) => u !== uid))}
                    >
                      <X size={12} />
                    </button>
                  </span>
                );
              })}
            </div>
            <div style={{ position: "relative" }}>
              <input
                className="input"
                placeholder={t("Search contacts to add…")}
                value={memberQuery}
                onChange={(e) => setMemberQuery(e.target.value)}
              />
              {memberCandidates.length > 0 && (
                <div className="suggest-list" style={{ width: "100%" }}>
                  {memberCandidates.map((c) => (
                    <div
                      key={c.id}
                      className="suggest-item"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setMemberUids([...memberUids, c.uid]);
                        setMemberQuery("");
                      }}
                    >
                      <span className="s-name">{contactDisplayName(c)}</span>
                      <span className="s-email">
                        {Object.values(c.emails ?? {})[0]?.address}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {personal && (
          <>
            <div className="field">
              <label>{t("Email")}</label>
              <div className="multi">
                {emails.map((e, i) => (
                  <div key={e.key} className="multi-row">
                    <input
                      className="input"
                      type="email"
                      value={e.address}
                      placeholder={t("name@example.com")}
                      onChange={(ev) =>
                        setEmails(
                          emails.map((x, j) =>
                            j === i ? { ...x, address: ev.target.value } : x,
                          ),
                        )
                      }
                    />
                    <select
                      className="select"
                      value={e.ctx}
                      onChange={(ev) =>
                        setEmails(
                          emails.map((x, j) =>
                            j === i ? { ...x, ctx: ev.target.value } : x,
                          ),
                        )
                      }
                    >
                      {EMAIL_CTX.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <button
                      className="icon-btn sm danger"
                      onClick={() => setEmails(emails.filter((_, j) => j !== i))}
                      aria-label={t("Remove")}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ alignSelf: "flex-start" }}
                  onClick={() =>
                    setEmails([
                      ...emails,
                      {
                        key: newKey("e"),
                        address: "",
                        ctx: emails.length ? "work" : "private",
                      },
                    ])
                  }
                >
                  <Plus size={14} /> {t("Add email")}
                </button>
              </div>
            </div>
            <div className="field">
              <label>{t("Phone")}</label>
              <div className="multi">
                {phones.map((p, i) => (
                  <div key={p.key} className="multi-row">
                    <input
                      className="input"
                      type="tel"
                      value={p.number}
                      placeholder="+1 555 0100"
                      onChange={(ev) =>
                        setPhones(
                          phones.map((x, j) =>
                            j === i ? { ...x, number: ev.target.value } : x,
                          ),
                        )
                      }
                    />
                    <select
                      className="select"
                      value={p.ctx}
                      onChange={(ev) =>
                        setPhones(
                          phones.map((x, j) =>
                            j === i ? { ...x, ctx: ev.target.value } : x,
                          ),
                        )
                      }
                    >
                      {PHONE_CTX.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <button
                      className="icon-btn sm danger"
                      onClick={() => setPhones(phones.filter((_, j) => j !== i))}
                      aria-label={t("Remove")}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ alignSelf: "flex-start" }}
                  onClick={() =>
                    setPhones([
                      ...phones,
                      { key: newKey("p"), number: "", ctx: "mobile" },
                    ])
                  }
                >
                  <Plus size={14} /> {t("Add phone")}
                </button>
              </div>
            </div>
            <div className="field">
              <label>{t("Address")}</label>
              <div className="multi">
                {addrs.map((a, i) => (
                  <div key={a.key} className="card" style={{ marginBottom: 0 }}>
                    <div className="row mb-8">
                      <select
                        className="select"
                        style={{ width: 140 }}
                        value={a.ctx}
                        onChange={(ev) =>
                          setAddrs(
                            addrs.map((x, j) =>
                              j === i ? { ...x, ctx: ev.target.value } : x,
                            ),
                          )
                        }
                      >
                        {ADDR_CTX.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <span className="spacer" />
                      <button
                        className="icon-btn sm danger"
                        onClick={() => setAddrs(addrs.filter((_, j) => j !== i))}
                        aria-label={t("Remove")}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    <div className="addr-grid">
                      <input
                        className="input"
                        style={{ gridColumn: "1 / -1" }}
                        placeholder={t("Street")}
                        value={a.street}
                        onChange={(ev) =>
                          setAddrs(
                            addrs.map((x, j) =>
                              j === i ? { ...x, street: ev.target.value } : x,
                            ),
                          )
                        }
                      />
                      <input
                        className="input"
                        placeholder={t("City")}
                        value={a.city}
                        onChange={(ev) =>
                          setAddrs(
                            addrs.map((x, j) =>
                              j === i ? { ...x, city: ev.target.value } : x,
                            ),
                          )
                        }
                      />
                      <input
                        className="input"
                        placeholder={t("State / Region")}
                        value={a.region}
                        onChange={(ev) =>
                          setAddrs(
                            addrs.map((x, j) =>
                              j === i ? { ...x, region: ev.target.value } : x,
                            ),
                          )
                        }
                      />
                      <input
                        className="input"
                        placeholder={t("Postal code")}
                        value={a.postcode}
                        onChange={(ev) =>
                          setAddrs(
                            addrs.map((x, j) =>
                              j === i ? { ...x, postcode: ev.target.value } : x,
                            ),
                          )
                        }
                      />
                      <input
                        className="input"
                        placeholder={t("Country")}
                        value={a.country}
                        onChange={(ev) =>
                          setAddrs(
                            addrs.map((x, j) =>
                              j === i ? { ...x, country: ev.target.value } : x,
                            ),
                          )
                        }
                      />
                    </div>
                  </div>
                ))}
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ alignSelf: "flex-start" }}
                  onClick={() =>
                    setAddrs([
                      ...addrs,
                      {
                        key: newKey("a"),
                        ctx: "private",
                        street: "",
                        city: "",
                        region: "",
                        postcode: "",
                        country: "",
                      },
                    ])
                  }
                >
                  <Plus size={14} /> {t("Add address")}
                </button>
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>{t("Birthday")}</label>
                <DateField
                  aria-label={t("Birthday")}
                  value={birthday}
                  onChange={setBirthday}
                />
              </div>
              <div className="field">
                <label>{t("Website")}</label>
                <input
                  className="input"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  placeholder={t("https://")}
                />
              </div>
            </div>
          </>
        )}
        <div className="field">
          <label>{t("Notes")}</label>
          <textarea
            className="textarea"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>
    </Dialog>
  );
}
