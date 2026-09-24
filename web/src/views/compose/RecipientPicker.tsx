import { Book, BookOpen, Search, Users, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ContactCard, EmailAddress } from "@/jmap/types";
import { contactDisplayName, contactEmails } from "@/lib/contacts";
import { plural, t } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { sharedKey } from "@/lib/sharedKey";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { useSettings } from "@/store/settings";
import { Dialog } from "@/ui/dialog";
import { Spinner } from "@/ui/misc";

export type Field = "to" | "cc" | "bcc";

/** One selectable address: a card can carry several, so the address is the unit. */
interface Row {
  key: string;
  name: string | null;
  email: string;
  book: string;
  /**
   * A group, picked as one row and expanded when it is chosen (ADR 0004):
   * its members are the cards of the account it lives in.
   */
  group?: { accountId: string; cardId: string; members: number };
}

/**
 * Choose recipients by looking through the address books.
 *
 * Autocomplete answers "finish this name for me", which is only useful when the
 * writer already knows who they want. This answers the other question -- who is
 * there? -- so the books can be read rather than recalled, and several people
 * picked in one pass rather than typed one at a time.
 *
 * Each address is its own row, not each person: someone with a work address and
 * a personal one is a choice to make, and a picker that offered the card and
 * quietly took the first address would make it for them.
 *
 * Shared books are in here on the same footing as the reader's own, which is
 * the point of having added them -- with the account named, so it is never a
 * mystery whose list a name came from.
 */
export function RecipientPicker({
  onPick,
  onClose,
}: {
  onPick: (field: Field, addresses: EmailAddress[]) => void;
  onClose: () => void;
}) {
  const contacts = useContacts();
  const [q, setQ] = useState("");
  const [bookKey, setBookKey] = useState<string>("all");
  const [picked, setPicked] = useState<Record<string, Row>>({});

  /*
   * Contacts are fetched on demand, and nothing had demanded them.
   *
   * `loadAll` runs when the Contacts view mounts, and `suggest` kicks it off
   * itself so autocomplete works from anywhere. This did neither, so opening a
   * composer without having visited Contacts first showed an empty picker over
   * a full address book -- "no contacts in this address book", about a book
   * with contacts in it.
   */
  useEffect(() => {
    if (contacts.available && !contacts.loaded && !contacts.loading)
      void contacts.loadAll();
    /* Shared books must answer here too, without a prior visit to Contacts.
       `loadShared` is idempotent and single-flight, so asking again is safe. */
    if (contacts.available && !contacts.sharedLoaded) void contacts.loadShared();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts.available, contacts.loaded, contacts.sharedLoaded]);

  /* Added counts whether the server remembered it or the settings did --
     Stalwart refuses the flag on a book shared read-only, so for those the
     settings are the only record and filtering on `isSubscribed` alone would
     leave every shared book out of the picker. A group mailbox's books need
     no adding at all: membership of the group is the subscription. */
  const addedShares = new Set(useSettings((s) => s.settings).addedShares);
  const mailAccounts = useMail((s) => s.mailAccounts);
  const groupIds = useMemo(
    () => new Set(groupMailboxAccounts(mailAccounts).map((a) => a.accountId)),
    [mailAccounts],
  );
  const subscribed = contacts.sharedBooks.filter(
    (b) =>
      groupIds.has(b.accountId) ||
      b.book.isSubscribed ||
      addedShares.has(sharedKey(b.accountId, b.book.id)),
  );
  const ownBooks = Object.values(contacts.books).sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );

  const rows = useMemo(() => {
    const out: Row[] = [];
    const push = (card: ContactCard, book: string, accountId: string) => {
      for (const a of contactEmails(card)) {
        if (!a.email) continue;
        out.push({
          key: `${accountId}:${card.id}:${a.email}`,
          name: a.name ?? contactDisplayName(card),
          email: a.email,
          book,
        });
      }
      /*
       * A group has no address, so it would never appear among the rows
       * above: it is offered as itself, and says how many people choosing it
       * will add (ADR 0004).
       */
      if (card.kind === "group")
        out.push({
          key: `${accountId}:${card.id}:group`,
          name: contactDisplayName(card),
          email: "",
          book,
          group: {
            accountId,
            cardId: card.id,
            members: Object.keys(card.members ?? {}).length,
          },
        });
    };
    if (bookKey === "all" || !bookKey.includes(":")) {
      for (const c of Object.values(contacts.cards)) {
        if (bookKey !== "all" && !c.addressBookIds?.[bookKey]) continue;
        push(
          c,
          // Named through the store, so the book a card is in is resolved the
          // same way here as everywhere else.
          contacts.bookNamesOf(c)[0] ?? "Contacts",
          contacts.accountId ?? "",
        );
      }
    }
    if (bookKey === "all" || bookKey.includes(":")) {
      for (const [key, card] of Object.entries(contacts.sharedCards)) {
        const accountId = key.slice(0, key.length - card.id.length - 1);
        const inBook = subscribed.find(
          (b) => b.accountId === accountId && card.addressBookIds?.[b.book.id],
        );
        if (!inBook) continue;
        if (bookKey !== "all" && bookKey !== `${accountId}:${inBook.book.id}`) continue;
        push(card, `${inBook.book.name} · ${inBook.accountName}`, accountId);
      }
    }
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? out.filter((r) =>
          `${r.name ?? ""} ${r.email} ${r.group ? "group" : ""}`
            .toLowerCase()
            .includes(needle),
        )
      : out;
    return filtered.sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));
  }, [contacts.cards, contacts.sharedCards, contacts.books, subscribed, bookKey, q]);

  const chosen = Object.values(picked);
  const toggle = (r: Row) =>
    setPicked((p) => {
      const next = { ...p };
      if (next[r.key]) delete next[r.key];
      else next[r.key] = r;
      return next;
    });

  const send = (field: Field) => {
    /*
     * A group is expanded here, by the one resolution every surface uses
     * (ADR 0004): one address per member, the ones with no address left out.
     * Somebody ticked twice -- by name and again inside a group -- is written
     * once.
     */
    const out: EmailAddress[] = [];
    const seen = new Set<string>();
    const take = (a: EmailAddress) => {
      const key = a.email.toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(a);
    };
    for (const r of chosen) {
      if (!r.group) {
        take({ name: r.name, email: r.email });
        continue;
      }
      const { accountId, cardId } = r.group;
      const card = contacts.cardsIn(accountId).find((c) => c.id === cardId);
      for (const a of card ? contacts.expandGroup(card, accountId).addresses : [])
        take(a);
    }
    onPick(field, out);
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("Choose recipients")}
      size="lg"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button className="btn" disabled={!chosen.length} onClick={() => send("bcc")}>
            {t("Bcc")}
          </button>
          <button className="btn" disabled={!chosen.length} onClick={() => send("cc")}>
            {t("Cc")}
          </button>
          <button
            className="btn btn-primary"
            disabled={!chosen.length}
            onClick={() => send("to")}
          >
            {chosen.length > 1 ? t("To — {n} people", { n: chosen.length }) : t("To")}
          </button>
        </>
      }
    >
      <div className="row gap-8" style={{ marginBottom: 10 }}>
        {/* Same shape as the contact list's own search box. */}
        <label
          className="search-input grow"
          style={{
            height: 38,
            background: "var(--bg-sunken)",
            borderRadius: 999,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 12px",
          }}
        >
          <Search size={15} className="faint" />
          <input
            className="grow"
            style={{
              background: "none",
              border: 0,
              outline: "none",
              color: "inherit",
              font: "inherit",
            }}
            placeholder={t("Search names and addresses")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
        </label>
        <select
          className="select"
          value={bookKey}
          onChange={(e) => setBookKey(e.target.value)}
          aria-label={t("Address book")}
        >
          <option value="all">{t("All address books")}</option>
          {ownBooks.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
          {subscribed.map((b) => (
            <option
              key={sharedKey(b.accountId, b.book.id)}
              value={sharedKey(b.accountId, b.book.id)}
            >
              {b.book.name} · {b.accountName}
            </option>
          ))}
        </select>
      </div>

      {chosen.length > 0 && (
        <div className="row wrap gap-4" style={{ marginBottom: 10 }}>
          {chosen.map((r) => (
            <button
              key={r.key}
              className="chip"
              onClick={() => toggle(r)}
              title={t("Remove")}
            >
              {r.name ?? r.email} <X size={12} />
            </button>
          ))}
        </div>
      )}

      <div style={{ maxHeight: "48vh", overflowY: "auto" }}>
        {contacts.loading && !rows.length ? (
          <Spinner label={t("Loading contacts…")} />
        ) : !rows.length ? (
          <p className="hint">
            {q ? t("Nobody matches that.") : t("No contacts in this address book.")}
          </p>
        ) : (
          rows.map((r) => (
            <label key={r.key} className="menu-item" style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={Boolean(picked[r.key])}
                onChange={() => toggle(r)}
              />
              {r.group ? (
                <Users size={16} className="faint" />
              ) : r.book.includes("·") ? (
                <BookOpen size={16} className="faint" />
              ) : (
                <Book size={16} className="faint" />
              )}
              <span className="grow truncate">
                <span>{r.name ?? r.email}</span>
                {r.group ? (
                  <span className="hint">
                    {" · "}
                    {plural(r.group.members, {
                      one: "group · {n} member",
                      other: "group · {n} members",
                    })}
                  </span>
                ) : (
                  r.name && <span className="hint"> · {r.email}</span>
                )}
              </span>
              <span className="hint nowrap">{r.book}</span>
            </label>
          ))
        )}
      </div>

      {!ownBooks.length && !subscribed.length && (
        <p className="hint" style={{ marginTop: 8 }}>
          <Users size={12} /> {t("No address books yet.")}
        </p>
      )}
    </Dialog>
  );
}
