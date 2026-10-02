import {
  ArrowLeft,
  Building2,
  Cake,
  Calendar as CalIcon,
  Download,
  FolderInput,
  Globe,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Pin,
  Plus,
  Search,
  StickyNote,
  Trash2,
  Users,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useSearch } from "wouter";
import { setErrorMessage } from "@/jmap/client";
import type { ContactCard } from "@/jmap/types";
import { avatarColor } from "@/lib/address";
import {
  type CardAddress,
  cardAddressFrom,
  cardAt,
  cardKey,
  cardPath,
} from "@/lib/contactAddress";
import {
  contactCompany,
  contactDisplayName,
  contactEmails,
  contactFieldLabel,
  contactPhoto,
  formatAddressLines,
  memberCards,
  sortKey,
  toVCard,
} from "@/lib/contacts";
import { formatDate, formatDateLong } from "@/lib/datetime";
import { downloadFile } from "@/lib/download";
import { GLOBAL_CONTACTS_ACCOUNT_ID } from "@/lib/globalContactsAdmin";
import { plural, t as translate } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { useMayMoveContact } from "@/lib/useMayMoveContact";
import { useCompose } from "@/store/compose";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";
import { confirmDialog, Dialog } from "@/ui/dialog";
import { Avatar, Empty, Spinner, useIsNarrow } from "@/ui/misc";
import { MenuItem, Popover, useMenu } from "@/ui/popover";
import { Splitter } from "@/ui/Splitter";
import { toast } from "@/ui/toast";
import { LazyContactEditor } from "../lazyPieces";

/*
 * The contact list's floor, and the room the contact itself keeps whatever the
 * list is dragged to. The default is not repeated here: it is the setting's
 * own (`DEFAULT_SETTINGS.contactsListWidth`), so the reset and a reader who
 * never dragged cannot disagree.
 */
const CONTACTS_LIST_MIN = 240;
const CONTACT_MIN = 360;

export function ContactsView({ id }: { id?: string }) {
  const [, navigate] = useLocation();
  const search = useSearch();
  const contacts = useContacts();
  const narrow = useIsNarrow();
  const listWidth = useSettings((s) => s.settings.contactsListWidth);
  const updateSettings = useSettings((s) => s.update);
  const layoutRef = useRef<HTMLDivElement>(null);
  /*
   * The width mid-drag, and a ref mirroring it for the end of a key press,
   * which follows the resize in the same tick -- the same pair as the mail
   * list's splitter, for the same reason: a render cannot hand the state back
   * in time.
   */
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const liveWidthRef = useRef<number | null>(null);
  const [q, setQ] = useState("");
  /* The mail store's probe is the one classifier for what is a group, read as
     state so the answer turns up when it lands -- the same read the sidebar and
     the editor make. */
  const mailAccounts = useMail((s) => s.mailAccounts);
  /* The book being shown lives in the store, because the list that chooses it
     is the app's own sidebar rather than anything this view owns. */
  const sel = contacts.selection;
  const bookId = sel.bookId;
  /*
   * The card the route names, and the account it lives in. An id is only unique
   * inside the account that minted it, so a reader's own card and a group's can
   * share one -- and a bare id resolves to the reader's own, which is how a
   * group's card became unreachable from a list that held both.
   */
  const address = cardAddressFrom(id, search, contacts.accountId);
  const [editing, setEditing] = useState<Partial<ContactCard> | null>(null);
  /* Which account the card being edited lives in -- half of its address, and
     what tells a save where to write. Null while the card is a new one. */
  const [editingAccount, setEditingAccount] = useState<string | null>(null);
  /*
   * The row a right-click menu belongs to, and the card it is about to be moved
   * from. Kept apart from the ticked selection: a move is one card's, and the
   * menu is opened on the row the pointer is over.
   */
  const [menuCard, setMenuCard] = useState<{
    card: ContactCard;
    accountId: string | null;
  } | null>(null);
  const [moving, setMoving] = useState<{
    card: ContactCard;
    accountId: string | null;
  } | null>(null);
  const menu = useMenu();
  /*
   * Whether this reader may move a card between accounts at all (ADR 0018).
   * Read through the rule's own hook, so the answer re-renders when the admin
   * flag moves rather than being read once when the view mounted.
   */
  const mayMove = useMayMoveContact();
  const openCompose = useCompose((s) => s.open);
  /*
   * Ticked rows, and the last one ticked so a shift-click has something to
   * reach back to. Kept here rather than in the store: this is the only list
   * of contacts there is, and nothing outside this view acts on a selection.
   *
   * Only the cards the reader may write where they live: another account's
   * card is deletable when the book holding it grants the write -- which a
   * group's own book does for a member (see `cardWritable`).
   */
  const [picked, setPicked] = useState<Record<string, true>>({});
  const lastPicked = useRef<string | null>(null);

  useEffect(() => {
    if (contacts.available && !contacts.loaded && !contacts.loading)
      void contacts.loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts.available, contacts.loaded]);

  /* A selection belongs to the book it was made in. Carrying it across to
     another book would leave a count on screen describing rows that are no
     longer there, and a Delete button aimed at them. */
  useEffect(() => {
    setPicked({});
    lastPicked.current = null;
  }, [bookId, sel.accountId]);

  useEffect(() => {
    const onNew = () => {
      setEditing({});
      setEditingAccount(null);
    };
    /*
     * Both carry the book they were asked for, so each action names the address
     * book it acts on instead of meaning "whatever the list is showing" -- the
     * ambiguity behind #174. They are opened from a book's own menu, which is
     * where that book is chosen.
     */
    const onImport = (ev: Event) => {
      const d = (ev as CustomEvent<{ file: File; bookId: string }>).detail;
      if (d?.file) void importFile(d.file, d.bookId);
    };
    const onExport = (ev: Event) => {
      const d = (ev as CustomEvent<{ accountId: string | null; bookId: string }>).detail;
      exportBook(d?.accountId ?? null, d?.bookId ?? "all");
    };
    window.addEventListener("ihm:new-contact", onNew);
    window.addEventListener("ihm:contacts-import", onImport);
    window.addEventListener("ihm:contacts-export", onExport);
    return () => {
      window.removeEventListener("ihm:new-contact", onNew);
      window.removeEventListener("ihm:contacts-import", onImport);
      window.removeEventListener("ihm:contacts-export", onExport);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  /* The group mailboxes the reader belongs to, per the mail store's probe: one
     classifier for the list that shows their contacts and for the note on a row
     that says which of them a card came from. */
  const groupCardAccounts = useMemo(
    () => groupMailboxAccounts(mailAccounts),
    [mailAccounts],
  );
  /*
   * **All contacts**: the reader's own cards, the installation's directory and
   * the cards of every group they belong to. A group's books need nobody to add
   * them -- membership of the group is the subscription, the same rule the
   * composer's suggestions and `loadShared` follow -- and the directory is read
   * by everyone through its route, so both are in the one list of everything.
   * Each group row says which group it came from, so the two are still told
   * apart without opening anything.
   *
   * A colleague's shared book is not a group's and stays out: that one the
   * reader adds deliberately, and it lives under `Shared with me` in the
   * sidebar. `cardsIn` reads the directory's and the groups' cards rather than
   * the whole shared cache, so what `loadShared` left unloaded (a stranger's
   * account) cannot arrive here by the back door.
   *
   * The one source for that set: the list draws it and "Export all contacts"
   * writes it, so what is exported is what is on screen rather than the half of
   * it that happens to live in the reader's own account.
   */
  const allCards = useMemo(
    () => [
      ...Object.values(contacts.cards),
      ...contacts.cardsIn(GLOBAL_CONTACTS_ACCOUNT_ID),
      ...groupCardAccounts.flatMap((g) => contacts.cardsIn(g.accountId)),
    ],
    [contacts, groupCardAccounts],
  );

  /*
   * The rows of the book being read, before the search box is applied: the
   * cards whose account and book the choice selects, with the account that
   * travels with each one.
   */
  const rowsInBook = useMemo(() => {
    const pairs: Array<{ card: ContactCard; accountId: string | null }> = [];
    // A shared book lists that account's cards; anything else lists the
    // reader's own. They are never mixed: whose contacts you are looking at is
    // the one thing this view must not be vague about.
    if (sel.accountId) {
      for (const card of contacts.cardsIn(sel.accountId))
        if (bookId === "all" || card.addressBookIds?.[bookId])
          pairs.push({ card, accountId: sel.accountId });
    } else if (bookId !== "all") {
      /* One book of the reader's own: a book is one account's, and a group's
         book is read under the group's own section. */
      for (const card of Object.values(contacts.cards))
        if (card.addressBookIds?.[bookId]) pairs.push({ card, accountId: null });
    } else {
      for (const card of Object.values(contacts.cards))
        pairs.push({ card, accountId: null });
      // The directory is read by everyone, so All contacts holds it too.
      for (const card of contacts.cardsIn(GLOBAL_CONTACTS_ACCOUNT_ID))
        pairs.push({ card, accountId: GLOBAL_CONTACTS_ACCOUNT_ID });
      for (const g of groupCardAccounts)
        for (const card of contacts.cardsIn(g.accountId))
          pairs.push({ card, accountId: g.accountId });
    }
    return pairs;
  }, [contacts, groupCardAccounts, bookId, sel.accountId]);

  /*
   * The query is the store's own filter, and the rows are put back by the card
   * they came from: one rule for what a search matches, and the account that
   * travelled with the card stays with it.
   */
  const listed = useMemo(() => {
    const kept = new Set(
      contacts.filterCards(
        rowsInBook.map((p) => p.card),
        q,
      ),
    );
    /*
     * Sorted again after the rows are put back by their book: `filterCards`
     * order is thrown away by the filter above, and the letter headings below
     * group on adjacency. Without this, the reader's own book and a group's
     * each restart at "A", so the same letter appears twice and two headings
     * share a React key.
     */
    return rowsInBook
      .filter((p) => kept.has(p.card))
      .sort((a, b) => sortKey(a.card).localeCompare(sortKey(b.card)));
  }, [contacts, rowsInBook, q]);

  /*
   * The rows a selection can act on: the directory is read-only from here, so
   * its cards carry no checkbox and "Select all" must not reach them.
   */
  const pickable = useMemo(
    () => listed.filter((i) => contacts.cardWritable(i.card, i.accountId)),
    [listed, contacts],
  );

  /*
   * The opened card, resolved by the account **and** id the route names -- not
   * by id alone, which prefers the reader's own map and leaves another
   * account's card carrying the same id unreachable. Whether *this* card is
   * theirs to write is its own question, and the store answers it from the book
   * that holds it: another account's when the route names one, never by falling
   * through to the reader's own map.
   */
  const found = cardAt(contacts.cards, contacts.sharedCards, address);

  /*
   * Whether the card the route names is one this book holds.
   *
   * A card belongs to the book it was opened from, so a card that is not in the
   * book on screen is not on screen -- the detail is not drawn and the route
   * stops naming it. Without that the pane went on showing the card of the book
   * the reader had left: with two group mailboxes, clicking the second group's
   * address book kept the first group's contact in front of them, and a group's
   * books invite it, because every account's default book carries the same id
   * ("b") and only the account beside the card tells two of them apart.
   *
   * Asked of the resolved card and not of the address, so the two cannot come to
   * different answers: what the route names is resolved once (`cardAt`, which
   * already answers a bare id from the account that holds it) and then met
   * against the rows, which are "the cards of this book" by construction. On the
   * search box alone nothing here moves -- a search narrows what is listed, and
   * the row that is open is not made to disappear by it.
   */
  const cardInBook = Boolean(
    found &&
      rowsInBook.some(
        (i) => i.card.id === found.card.id && (i.accountId ?? null) === found.accountId,
      ),
  );
  const opened = cardInBook ? found : undefined;

  /*
   * And the route gives up a card the book no longer holds.
   *
   * The two answers must not disagree: the list is the book being read, so the
   * address cannot go on naming a card of another one. `replace`, because
   * leaving a book is not a step anybody means to go back to.
   *
   * Waited for the load that can judge it. A card is judged against the cards
   * this reader holds, and before they arrive every group's book is empty -- so
   * acting early would throw away a deep link that is perfectly good. Nothing
   * is drawn in that window either way (`cardInBook` is false and the pane is
   * the placeholder), and the effect runs again when the cards land.
   */
  useEffect(() => {
    if (!address) return;
    const needsShared = Boolean(address.accountId);
    if (needsShared ? !contacts.sharedLoaded : !contacts.loaded) return;
    if (cardInBook) return;
    navigate("/contacts", { replace: true });
  }, [
    address?.id,
    address?.accountId,
    cardInBook,
    contacts.loaded,
    contacts.sharedLoaded,
    navigate,
  ]);

  /* The same rows as cards: the two places that work by id alone -- the tick a
     shift-click reaches back to, and the export -- read the cards the list is
     drawing. */
  const list = useMemo(() => listed.map((i) => i.card), [listed]);

  /*
   * The group a row came from, named on the row itself and nowhere else: only
   * in the one list that mixes them. A group's own section already says whose
   * contacts you are looking at, and a note repeating it would be noise.
   */
  const showingAll = !sel.accountId && bookId === "all";
  const groupNameOf = (accountId: string | null) =>
    accountId && showingAll
      ? groupCardAccounts.find((g) => g.accountId === accountId)?.name
      : undefined;

  const openMenuAt = (e: React.MouseEvent, c: ContactCard, accountId: string | null) => {
    e.preventDefault();
    setMenuCard({ card: c, accountId });
    menu.openAt(e.clientX, e.clientY);
  };

  const selected = opened?.card;
  const selectedAccountId = opened?.accountId ?? null;
  /*
   * Whether the controls that write this card are withheld -- which is a
   * question about the book holding it, not about whose account it is in. A
   * group's own address book is another account's and its members write it, so
   * an ownership test would take Edit and Delete away from the people the
   * group's contacts exist for. `cardWritable` asks the book, and withholds
   * while the answer is unknown rather than guessing either way.
   */
  const selectedReadOnly = selected
    ? !contacts.cardWritable(selected, selectedAccountId)
    : false;
  const books = Object.values(contacts.books).sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
  const groups = useMemo(() => {
    const out: Array<{
      letter: string;
      items: Array<{ card: ContactCard; accountId: string | null }>;
    }> = [];
    for (const item of listed) {
      const letter = (sortKey(item.card)[0] ?? "#").toUpperCase();
      const key = /[A-Z]/.test(letter) ? letter : "#";
      const g = out[out.length - 1];
      if (g && g.letter === key) g.items.push(item);
      else out.push({ letter: key, items: [item] });
    }
    return out;
  }, [listed]);
  /* Ticked *and* on screen. A selection outlives a search box being typed
     into, and deleting rows that scrolled out of view is not what the count
     on the bar promised. Held as addresses, because an id is not one: the
     reader's own card and a group's can carry the same id, and the delete has
     to name the account it acts on. */
  const pickedRefs = useMemo(
    () =>
      listed
        .filter((i) => picked[cardKey({ id: i.card.id, accountId: i.accountId })])
        .map((i) => ({ id: i.card.id, accountId: i.accountId })),
    [listed, picked],
  );

  if (!contacts.available) {
    return (
      <div className="p-16">
        <Empty icon={<Users size={40} />} title={translate("Contacts are not available")}>
          {translate("This account does not have the JMAP contacts capability.")}
        </Empty>
      </div>
    );
  }

  /*
   * The cards of the book that was asked for, rather than the cards on screen.
   * Exporting the current list would let a search box with something in it
   * quietly narrow the export, which is wrong for an action opened from a book
   * in the sidebar.
   *
   * "All contacts" is the one case with more than one account behind it, and it
   * reads the set the list itself draws (`allCards`): the reader's own cards and
   * every group's, so exporting everything exports what "everything" shows.
   */
  const cardsOf = (accountId: string | null, book: string) => {
    if (accountId) {
      const prefix = `${accountId}:`;
      return Object.entries(contacts.sharedCards)
        .filter(([key]) => key.startsWith(prefix))
        .map(([, c]) => c)
        .filter((c) => book === "all" || c.addressBookIds?.[book]);
    }
    const mine = Object.values(contacts.cards);
    return book === "all" ? allCards : mine.filter((c) => c.addressBookIds?.[book]);
  };

  const exportBook = (accountId: string | null, book: string) => {
    const cards = cardsOf(accountId, book);
    if (!cards.length) {
      toast.error(translate("There is nothing in it to export"));
      return;
    }
    downloadFile(cards.map(toVCard).join(""), "text/vcard", "contacts.vcf");
  };

  const importFile = async (f: File, intoBookId?: string) => {
    const target = intoBookId && intoBookId !== "all" ? intoBookId : bookId;
    const book =
      target !== "all"
        ? contacts.books[target]
        : (books.find((b) => b.isDefault) ?? books[0]);
    if (!book) {
      toast.error(translate("Create an address book first"));
      return;
    }
    try {
      const text = await f.text();
      /*
       * Which format, decided by what is in the file rather than by what it is
       * called. A vCard says so on its first line; an address book exported as
       * LDIF may arrive as .ldif, .ldi, .txt or with no extension at all, and
       * the name is the least reliable thing about it.
       */
      const { created, updated, alike } = /^\s*BEGIN:VCARD/im.test(text)
        ? await contacts.importVCard(text, book.id)
        : await contacts.importLdif(text, book.id);
      /*
       * The counts kept apart, as the calendar import keeps them. "Imported 3
       * contacts" over a file of two hundred reads as a failure when the other
       * hundred and ninety-seven were updated, and a re-import of a corrected
       * export -- the reason for doing this at all -- creates nothing and would
       * otherwise report importing nothing.
       */
      const imported = plural(created, {
        one: "Imported {n} contact",
        other: "Imported {n} contacts",
      });
      const refreshed = plural(updated, { one: "{n} updated", other: "{n} updated" });
      if (!created)
        toast.success(
          plural(updated, {
            one: "Updated {n} contact, nothing new",
            other: "Updated {n} contacts, nothing new",
          }),
        );
      else if (updated) toast.success(`${imported} · ${refreshed}`);
      else toast.success(imported);
      /*
       * Said separately, and after, because it is a different kind of fact.
       * These were not matched and are here twice now -- an LDIF entry whose
       * `dn` moved between exports, or one imported before there was a `dn` to
       * match on. Name-plus-email is enough to notice that and not enough to
       * merge on, so it is reported and left alone (#223).
       */
      if (alike) {
        toast.show(
          plural(alike, {
            one: "{n} of them looks like a contact you already had",
            other: "{n} of them look like contacts you already had",
          }),
          { duration: 9000 },
        );
      }
    } catch (err) {
      toast.error(
        translate("Could not import this file: {error}", {
          error: (err as Error).message,
        }),
      );
    }
  };

  /* Ticking a box, with shift reaching back to the last one ticked. The range
     is taken from the rows as they are grouped and sorted on screen rather than
     the order the store happens to hold them in, and both ends are **addresses**:
     an id alone cannot say which of two rows carrying it was ticked. */
  const tick = (key: string, on: boolean, range: boolean) => {
    const keyOf = (i: { card: ContactCard; accountId: string | null }) =>
      cardKey({ id: i.card.id, accountId: i.accountId });
    /* The anchor is read here and not inside the updater below. React runs an
       updater when it gets round to rendering, by which time the ref has
       already been moved to this row -- so the range would be measured from
       the row that ended it and collapse to that one row. */
    const anchor = range ? lastPicked.current : null;
    const a = anchor ? listed.findIndex((i) => keyOf(i) === anchor) : -1;
    const b = listed.findIndex((i) => keyOf(i) === key);
    const keys =
      a >= 0 && b >= 0
        ? listed.slice(Math.min(a, b), Math.max(a, b) + 1).map(keyOf)
        : [key];
    setPicked((prev) => {
      const next = { ...prev };
      for (const k of keys) {
        if (on) next[k] = true;
        else delete next[k];
      }
      return next;
    });
    lastPicked.current = key;
  };

  const clearPicked = () => {
    setPicked({});
    lastPicked.current = null;
  };

  const deletePicked = async () => {
    const n = pickedRefs.length;
    if (!n) return;
    /* Whether the card on screen is one of them -- its address, not its id: two
       rows can share an id, and the one left open is the one that has to go. */
    const cardWasDeleted = Boolean(
      address &&
        pickedRefs.some(
          (r) =>
            r.id === address.id && (r.accountId ?? null) === (address.accountId ?? null),
        ),
    );
    if (
      !(await confirmDialog({
        title: plural(n, { one: "Delete {n} contact?", other: "Delete {n} contacts?" }),
        message: translate("This cannot be undone."),
        confirmLabel: translate("Delete"),
        danger: true,
      }))
    )
      return;
    try {
      /* What the server confirmed, not what was asked. A refusal that took
         half of them still deleted the other half, and saying "it failed"
         sends you looking for contacts that are already gone. */
      const { destroyed, refused } = await contacts.destroyCards(pickedRefs);
      clearPicked();
      if (destroyed)
        toast.success(
          plural(destroyed, {
            one: "Deleted {n} contact",
            other: "Deleted {n} contacts",
          }),
        );
      if (refused)
        toast.error(
          translate("Some could not be deleted: {error}", {
            error: setErrorMessage(refused),
          }),
        );
      if (destroyed && cardWasDeleted) navigate("/contacts");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const shownListWidth = liveWidth ?? listWidth;
  /*
   * The floor keeps a name and an address legible; the ceiling leaves the
   * contact its own 360px on whatever the layout is actually wide, so the
   * list can never take the page. Clamped against the measured width rather
   * than the window, because the sidebar beside this pane is resizable too.
   */
  const onSplit = (delta: number) => {
    const total = layoutRef.current?.clientWidth ?? 1200;
    const max = Math.max(CONTACTS_LIST_MIN, total - CONTACT_MIN);
    const next = Math.min(
      max,
      Math.max(CONTACTS_LIST_MIN, (liveWidthRef.current ?? shownListWidth) + delta),
    );
    liveWidthRef.current = next;
    setLiveWidth(next);
  };
  const onSplitEnd = () => {
    const width = liveWidthRef.current;
    liveWidthRef.current = null;
    setLiveWidth(null);
    if (width != null) updateSettings({ contactsListWidth: width });
  };

  return (
    <div
      ref={layoutRef}
      className={`contacts-layout ${selected || editing ? "detail" : ""}`}
      style={{ "--list-size": `${shownListWidth}px` } as CSSProperties}
    >
      <section className="contacts-list">
        {pickedRefs.length ? (
          /* The search box gives way rather than sitting alongside: what the
             bar counts is what the search left on screen, so leaving the box
             where it is invites narrowing the list under your own selection. */
          <div className="list-search row contacts-selbar">
            <input
              type="checkbox"
              className="contact-check"
              checked={pickedRefs.length === pickable.length && pickable.length > 0}
              ref={(el) => {
                if (el)
                  el.indeterminate =
                    pickedRefs.length > 0 && pickedRefs.length < pickable.length;
              }}
              onChange={(e) => {
                if (e.target.checked) {
                  setPicked(
                    Object.fromEntries(
                      pickable.map((i) => [
                        cardKey({ id: i.card.id, accountId: i.accountId }),
                        true as const,
                      ]),
                    ),
                  );
                } else clearPicked();
              }}
              aria-label={translate("Select all")}
            />
            <span className="grow">
              {plural(pickedRefs.length, { one: "{n} selected", other: "{n} selected" })}
            </span>
            <button
              className="icon-btn"
              title={translate("Delete")}
              onClick={() => void deletePicked()}
            >
              <Trash2 size={19} />
            </button>
            <button
              className="icon-btn"
              title={translate("Clear selection")}
              onClick={clearPicked}
            >
              <X size={19} />
            </button>
          </div>
        ) : (
          <div className="list-search row">
            <div
              className="search-input"
              style={{
                flex: 1,
                minWidth: 0,
                height: 38,
                background: "var(--bg-sunken)",
                borderRadius: 999,
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 12px",
              }}
            >
              <Search size={16} className="muted" />
              <input
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: 0,
                  background: "transparent",
                  outline: "none",
                }}
                placeholder={translate("Search contacts")}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <button
              className="icon-btn"
              title={translate("New contact")}
              onClick={() => {
                setEditing({});
                setEditingAccount(null);
              }}
            >
              <Plus size={20} />
            </button>
          </div>
        )}
        <div className={`contacts-scroll ${pickedRefs.length ? "has-selection" : ""}`}>
          {contacts.loading && !contacts.loaded ? (
            <Spinner label={translate("Loading contacts…")} />
          ) : !list.length ? (
            <Empty
              icon={<Users size={36} />}
              title={q ? translate("No matches") : translate("No contacts yet")}
            >
              {q
                ? translate("Try another search.")
                : translate("Add a contact or import a vCard file.")}
            </Empty>
          ) : (
            groups.map((g) => (
              <div key={g.letter}>
                <div className="contact-letter">{g.letter}</div>
                {g.items.map(({ card: c, accountId: cardAccountId }) => {
                  const name = contactDisplayName(c);
                  const email = contactEmails(c)[0]?.email;
                  /*
                   * The company beside a person's name, and never beside the
                   * name it already is: a card with no person name of its own
                   * is shown as its company, and saying it twice reads as two
                   * facts. An organisation says what it is instead -- its own
                   * name is the company.
                   */
                  const company = contactCompany(c);
                  const beside = company && company !== name ? company : null;
                  /*
                   * The account the row is drawn from, which is the one the
                   * card itself came from -- `cardAccountId` -- and not an id
                   * looked up in the maps: a card of a group's book and one of
                   * the reader's own can carry the same id, and the lookup
                   * answers with the reader's own.
                   */
                  const photoAccount = cardAccountId ?? contacts.accountId;
                  const photo = photoAccount ? contactPhoto(c, photoAccount) : null;
                  const groupName = groupNameOf(cardAccountId);
                  /* Two rows of a list can carry one id between them: the
                     address of a row is the card's account and its id, and the
                     highlight is that address, not the id alone. */
                  const isOpen =
                    address?.id === c.id && (address.accountId ?? null) === cardAccountId;
                  /* The key this row is ticked under: its address, in one string. */
                  const rowKey = cardKey({ id: c.id, accountId: cardAccountId });
                  return (
                    <div
                      key={`${cardAccountId ?? "own"}:${c.id}`}
                      className={`contact-row ${isOpen ? "active" : ""} ${picked[rowKey] ? "picked" : ""}`}
                      onClick={() =>
                        navigate(cardPath({ id: c.id, accountId: cardAccountId }))
                      }
                      /*
                       * The one action that is about where the card lives rather
                       * than what is in it: a right-click offers it, and the move
                       * dialog asks the destination. Nothing is drawn on a row
                       * that has nowhere to go, so the menu is opened only where
                       * the reader may move one (ADR 0018). The directory is
                       * read through a route rather than held in an account, so
                       * it has nowhere to go and is left out (ADR 0023).
                       */
                      onContextMenu={
                        mayMove && cardAccountId !== GLOBAL_CONTACTS_ACCOUNT_ID
                          ? (e) => openMenuAt(e, c, cardAccountId)
                          : undefined
                      }
                    >
                      {contacts.cardWritable(c, cardAccountId) && (
                        <input
                          type="checkbox"
                          className="contact-check"
                          checked={Boolean(picked[rowKey])}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            tick(rowKey, !picked[rowKey], ev.shiftKey);
                          }}
                          onChange={() => {}}
                          aria-label={translate("Select")}
                        />
                      )}
                      <span
                        className="avatar"
                        style={{
                          background: photo ? "transparent" : avatarColor(email ?? name),
                        }}
                      >
                        {photo ? (
                          <img src={photo} alt="" />
                        ) : c.kind === "group" ? (
                          <Users size={16} />
                        ) : (
                          name.slice(0, 1).toUpperCase()
                        )}
                      </span>
                      <div className="grow" style={{ minWidth: 0 }}>
                        {/*
                          What kind of entry this is, told without a word
                          wherever a word is not needed: a group's name is set
                          bold, an organisation says so, and a person's name
                          carries the company they belong to beside it -- so an
                          organisation and a person who works for one no longer
                          read the same.
                        */}
                        <div className={`c-name ${c.kind === "group" ? "is-group" : ""}`}>
                          <span>{name}</span>
                          {c.kind === "org" && (
                            <span className="hint"> {translate("· organization")}</span>
                          )}
                          {c.kind !== "org" && beside && (
                            <span className="c-company">{beside}</span>
                          )}
                        </div>
                        <div className="c-email">
                          {email ?? Object.values(c.phones ?? {})[0]?.number ?? ""}
                        </div>
                      </div>
                      {groupName && (
                        <span
                          className="c-group"
                          title={translate("From the group {group}", {
                            group: groupName,
                          })}
                        >
                          {groupName}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </section>
      {!narrow && (
        <Splitter
          direction="vertical"
          onResize={onSplit}
          onEnd={onSplitEnd}
          onReset={() =>
            updateSettings({ contactsListWidth: DEFAULT_SETTINGS.contactsListWidth })
          }
          ariaLabel={translate("Resize contact list")}
        />
      )}

      <section className="contact-detail">
        {selected ? (
          <ContactDetail
            card={selected}
            accountId={selectedAccountId}
            readOnly={selectedReadOnly}
            onBack={() => navigate("/contacts")}
            onEdit={() => {
              setEditing(selected);
              setEditingAccount(selectedAccountId);
            }}
            narrow={narrow}
            onEmail={(addr) =>
              openCompose({ to: [{ name: contactDisplayName(selected), email: addr }] })
            }
          />
        ) : (
          <div className="no-thread">
            <Users size={48} style={{ color: "var(--fg-faint)" }} />
            <div>{translate("Select a contact")}</div>
          </div>
        )}
      </section>
      {editing && (
        <Suspense fallback={null}>
          <LazyContactEditor
            card={editing}
            defaultBookId={
              bookId !== "all"
                ? bookId
                : (books.find((b) => b.isDefault)?.id ?? books[0]?.id ?? null)
            }
            sourceAccountId={editing.id ? (editingAccount ?? contacts.accountId) : null}
            defaultAccountId={sel.accountId ?? contacts.accountId ?? null}
            onClose={() => {
              setEditing(null);
              setEditingAccount(null);
            }}
            onSaved={(saved) => {
              setEditing(null);
              setEditingAccount(null);
              navigate(cardPath(saved));
            }}
          />
        </Suspense>
      )}
      {/* The right-click menu, and the one entry an administrator's session
          has in it: where the card lives. */}
      <Popover
        anchor={menu.anchor}
        onClose={menu.close}
        trigger={menu.trigger}
        width={230}
      >
        {menuCard && (
          <MenuItem
            icon={<FolderInput size={16} />}
            label={translate("Move to…")}
            onClick={() => {
              setMoving(menuCard);
              setMenuCard(null);
            }}
          />
        )}
      </Popover>
      {moving && (
        <MoveContactDialog
          card={moving.card}
          accountId={moving.accountId}
          onClose={() => setMoving(null)}
          onMoved={(moved) => {
            setMoving(null);
            clearPicked();
            navigate(cardPath(moved));
            toast.success(translate("Contact moved"));
          }}
        />
      )}
    </div>
  );
}

/**
 * Where a contact is moved to: a book, in one of the accounts the reader
 * reaches, and a question only an administrator's session is asked at all
 * (ADR 0018).
 *
 * Grouped by the account that owns the book, because that is what the move
 * changes -- a book named "Team" in two groups is two destinations, and the
 * account is the half a reader has to know. The reader's own books are offered
 * only while the card is somewhere else: moving a card between two of your own
 * books changes nothing about whose it is, and it is done in the editor.
 *
 * The move itself is the store's (`moveCardTo`), which copies the card into the
 * target account and destroys the original, so the id changes and the caller
 * navigates to the new one.
 */
function MoveContactDialog({
  card,
  accountId,
  onClose,
  onMoved,
}: {
  card: ContactCard;
  /** The account holding the card, half of its address -- null for the reader's own. */
  accountId: string | null;
  onClose: () => void;
  onMoved: (moved: CardAddress) => void;
}) {
  const contacts = useContacts();
  const mailAccounts = useMail((s) => s.mailAccounts);
  const [busy, setBusy] = useState(false);
  /* The card's own account, told rather than looked up: a card of another
     account and one of the reader's own can carry the same id, and an id lookup
     answers with the reader's own. */
  const fromAccount = accountId ?? contacts.accountId;
  const ownBooks = Object.values(contacts.books).sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
  /* The groups, each with its own books: a book nobody's member could write is
     still listed, and the server refuses it in its own words rather than the
     picker hiding a destination that exists. */
  const groups = groupMailboxAccounts(mailAccounts).map((g) => ({
    accountId: g.accountId,
    accountName: g.name,
    books: contacts.sharedBooks
      .filter((b) => b.accountId === g.accountId)
      .map((b) => b.book)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
  }));
  const elsewhere = fromAccount !== contacts.accountId;

  const move = async (accountId: string, bookId: string) => {
    if (!fromAccount) return;
    setBusy(true);
    try {
      const newId = await contacts.moveCardTo(card.id, fromAccount, accountId, bookId);
      /* The copy lives in the account the reader chose: its address says so, or
         the new card would be resolved against the reader's own map. */
      onMoved({
        id: newId,
        accountId: accountId === contacts.accountId ? null : accountId,
      });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={translate("Move {name} to…", { name: contactDisplayName(card) })}
    >
      {groups.map((g) => (
        <div key={g.accountId}>
          <div className="nav-section">
            <span>{g.accountName}</span>
          </div>
          {g.books.length ? (
            g.books.map((b) => (
              <button
                key={b.id}
                className="menu-item"
                disabled={busy}
                onClick={() => void move(g.accountId, b.id)}
              >
                <Users size={16} />
                <span className="grow truncate">{b.name}</span>
              </button>
            ))
          ) : (
            <p className="hint" style={{ padding: "4px 12px" }}>
              {translate("This group keeps no address books.")}
            </p>
          )}
        </div>
      ))}
      {elsewhere && (
        <div>
          <div className="nav-section">
            <span>{translate("My address books")}</span>
          </div>
          {ownBooks.map((b) => (
            <button
              key={b.id}
              className="menu-item"
              disabled={busy}
              onClick={() => void move(contacts.accountId ?? "", b.id)}
            >
              <FolderInput size={16} />
              <span className="grow truncate">{b.name}</span>
            </button>
          ))}
        </div>
      )}
      {!groups.length && !elsewhere && (
        <p className="hint">{translate("There is nowhere else to move it.")}</p>
      )}
    </Dialog>
  );
}

function ContactDetail({
  card: c,
  accountId,
  readOnly,
  onBack,
  onEdit,
  narrow,
  onEmail,
}: {
  card: ContactCard;
  /**
   * The account holding this card, half of its address -- null for the reader's
   * own. Told rather than looked up: a card of a group's book and one of the
   * reader's own can carry the same id, and an id lookup answers with the
   * reader's own.
   */
  accountId: string | null;
  /**
   * A card the store knows is another account's: the reader's own list is in,
   * and this id is not in it. Editing and deleting it are that account's to
   * allow.
   */
  readOnly: boolean;
  onBack: () => void;
  onEdit: () => void;
  narrow: boolean;
  onEmail: (addr: string) => void;
}) {
  const contacts = useContacts();
  const [, navigate] = useLocation();
  const photoAccount = accountId ?? contacts.accountId;
  const photo = photoAccount ? contactPhoto(c, photoAccount) : null;
  const name = contactDisplayName(c);
  const org = Object.values(c.organizations ?? {})[0];
  const title = Object.values(c.titles ?? {})[0];
  const books = contacts.bookNamesOf(c, accountId);
  /*
   * A group's members live where the group does: a uid means nothing outside
   * the account holding the card, so the cards to look through are that
   * account's -- the reader's own books, or the group's (ADR 0004).
   */
  const groupAccount = accountId ?? contacts.accountId;
  const members =
    c.kind === "group" ? memberCards(contacts.cardsIn(groupAccount), c.members) : [];
  const ctxLabel = (ctx?: Record<string, boolean>, label?: string) =>
    contactFieldLabel(label, ctx);

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        {narrow && (
          <button className="icon-btn" onClick={onBack} aria-label={translate("Back")}>
            <ArrowLeft size={20} />
          </button>
        )}
        <span className="spacer" />
        {!readOnly && (
          <button className="btn btn-sm" onClick={onEdit}>
            <Pencil size={14} /> {translate("Edit")}
          </button>
        )}
        <button
          className="btn btn-sm"
          onClick={() => {
            downloadFile(
              toVCard(c),
              "text/vcard",
              `${name.replace(/[^\w.-]+/g, "_")}.vcf`,
            );
          }}
        >
          <Download size={14} /> {translate("vCard")}
        </button>
        {!readOnly && (
          <button
            className="btn btn-sm btn-ghost"
            style={{ color: "var(--danger)" }}
            onClick={async () => {
              if (
                await confirmDialog({
                  title: translate("Delete {name}?", { name }),
                  confirmLabel: translate("Delete"),
                  danger: true,
                })
              ) {
                try {
                  const { destroyed, refused } = await contacts.destroyCards([
                    { id: c.id, accountId },
                  ]);
                  if (!destroyed) {
                    toast.error(
                      refused
                        ? setErrorMessage(refused)
                        : translate("It was not deleted"),
                    );
                    return;
                  }
                  toast.success(translate("Contact deleted"));
                  navigate("/contacts");
                } catch (err) {
                  toast.error((err as Error).message);
                }
              }
            }}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {readOnly && (
        <p className="hint">
          {translate(
            "An address book another account shared with you holds this contact, so editing and deleting it are that account's to allow — neither is offered here.",
          )}
        </p>
      )}
      <div className="contact-hero">
        <span
          className="avatar xl"
          style={{
            background: photo
              ? "transparent"
              : avatarColor(contactEmails(c)[0]?.email ?? name),
          }}
        >
          {photo ? (
            <img src={photo} alt="" />
          ) : c.kind === "group" ? (
            <Users size={36} />
          ) : (
            name.slice(0, 1).toUpperCase()
          )}
        </span>
        <div>
          <h1>{name}</h1>
          {(title?.name || org?.name) && (
            <div className="sub">
              {[title?.name, org?.name].filter(Boolean).join(" · ")}
            </div>
          )}
          {Object.values(c.nicknames ?? {})[0]?.name && (
            <div className="sub">“{Object.values(c.nicknames ?? {})[0]!.name}”</div>
          )}
          {books.length > 0 && <div className="hint">{books.join(", ")}</div>}
        </div>
      </div>
      {/* A group is a set of people, not a person: none of the fields
          that describe one are shown for it, wherever it is filed. */}
      {c.kind !== "group" && (
        <>
          {Object.values(c.emails ?? {}).length > 0 && (
            <div className="contact-section">
              <h3>{translate("Email")}</h3>
              {Object.values(c.emails ?? {}).map((e, i) => (
                <div key={i} className="contact-kv">
                  <span className="k">{ctxLabel(e.contexts, e.label) || "email"}</span>
                  <span className="v row gap-8">
                    <a
                      href={`mailto:${e.address}`}
                      onClick={(ev) => {
                        ev.preventDefault();
                        onEmail(e.address);
                      }}
                    >
                      {e.address}
                    </a>
                    <button
                      className="icon-btn xs"
                      title={translate("Compose")}
                      onClick={() => onEmail(e.address)}
                    >
                      <Mail size={14} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
          {Object.values(c.phones ?? {}).length > 0 && (
            <div className="contact-section">
              <h3>{translate("Phone")}</h3>
              {Object.values(c.phones ?? {}).map((p, i) => (
                <div key={i} className="contact-kv">
                  <span className="k">
                    {ctxLabel({ ...p.contexts, ...p.features }, p.label) || "phone"}
                  </span>
                  <span className="v row gap-8">
                    <Phone size={14} className="muted" />
                    {p.number}
                  </span>
                </div>
              ))}
            </div>
          )}
          {Object.values(c.addresses ?? {}).length > 0 && (
            <div className="contact-section">
              <h3>{translate("Address")}</h3>
              {Object.values(c.addresses ?? {}).map((a, i) => (
                <div key={i} className="contact-kv">
                  <span className="k">{ctxLabel(a.contexts) || "address"}</span>
                  <span className="v row gap-8" style={{ alignItems: "flex-start" }}>
                    <MapPin size={14} className="muted" style={{ marginTop: 3 }} />
                    <span>
                      {formatAddressLines(a).map((l, j) => (
                        <div key={j}>{l}</div>
                      ))}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
          {(org || Object.values(c.titles ?? {}).length > 1) && (
            <div className="contact-section">
              <h3>{translate("Work")}</h3>
              {org?.name && (
                <div className="contact-kv">
                  <span className="k">{translate("Company")}</span>
                  <span className="v row gap-8">
                    <Building2 size={14} className="muted" />
                    {`${org.name}${org.units?.length ? ` · ${org.units.map((u) => u.name).join(", ")}` : ""}`}
                  </span>
                </div>
              )}
              {Object.values(c.titles ?? {}).map((t, i) => (
                <div key={i} className="contact-kv">
                  <span className="k">{t.kind === "role" ? "Role" : "Title"}</span>
                  <span className="v">{t.name}</span>
                </div>
              ))}
            </div>
          )}
          {Object.values(c.anniversaries ?? {}).length > 0 && (
            <div className="contact-section">
              <h3>{translate("Dates")}</h3>
              {Object.values(c.anniversaries ?? {}).map((a, i) => (
                <div key={i} className="contact-kv">
                  <span className="k">
                    {a.kind === "birth"
                      ? "Birthday"
                      : a.kind === "wedding"
                        ? "Anniversary"
                        : a.kind}
                  </span>
                  <span className="v row gap-8">
                    <Cake size={14} className="muted" />
                    {fmtPartial(a.date)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {(Object.values(c.links ?? {}).length > 0 ||
            Object.values(c.onlineServices ?? {}).length > 0) && (
            <div className="contact-section">
              <h3>{translate("Online")}</h3>
              {Object.values(c.links ?? {}).map((l, i) => (
                <div key={`l${i}`} className="contact-kv">
                  <span className="k">{l.label ?? "Website"}</span>
                  <span className="v row gap-8">
                    <Globe size={14} className="muted" />
                    <a href={l.uri} target="_blank" rel="noreferrer">
                      {l.uri}
                    </a>
                  </span>
                </div>
              ))}
              {Object.values(c.onlineServices ?? {}).map((s, i) => (
                <div key={`s${i}`} className="contact-kv">
                  <span className="k">{s.service ?? s.label ?? "IM"}</span>
                  <span className="v">{s.user ?? s.uri}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {Object.values(c.notes ?? {}).length > 0 && (
        <div className="contact-section">
          <h3>{translate("Notes")}</h3>
          {Object.values(c.notes ?? {}).map((n, i) => (
            <div key={i} className="contact-kv">
              <span className="k">
                <StickyNote size={14} />
              </span>
              <span className="v" style={{ whiteSpace: "pre-wrap" }}>
                {n.note}
              </span>
            </div>
          ))}
        </div>
      )}
      {c.kind === "group" && (
        <div className="contact-section">
          <h3>
            {translate("Members ({count})", {
              count: Object.keys(c.members ?? {}).length,
            })}
          </h3>
          {members.map((m) => (
            <div key={m.id} className="contact-kv">
              <span className="k">
                <Avatar
                  who={{ name: contactDisplayName(m), email: contactEmails(m)[0]?.email }}
                  size="sm"
                />
              </span>
              <span className="v">
                <a
                  href={cardPath({ id: m.id, accountId })}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(cardPath({ id: m.id, accountId }));
                  }}
                >
                  {contactDisplayName(m)}
                </a>{" "}
                <span className="hint">{contactEmails(m)[0]?.email}</span>
              </span>
            </div>
          ))}
          {members.length > 0 && (
            <button
              className="btn btn-sm mt-8"
              onClick={() =>
                // The same resolution the composer uses, so the addresses that
                // land in a draft are the ones a group stands for (ADR 0004).
                useCompose
                  .getState()
                  .open({ to: contacts.expandGroup(c, groupAccount).addresses })
              }
            >
              <Mail size={14} /> {translate("Email group")}
            </button>
          )}
        </div>
      )}
      {c.keywords && Object.keys(c.keywords).length > 0 && (
        <div className="row wrap gap-4 mt-8">
          {Object.keys(c.keywords).map((k) => (
            <span key={k} className="chip">
              <Pin size={12} /> {k}
            </span>
          ))}
        </div>
      )}
      {c.updated && (
        <p className="hint mt-16">
          <CalIcon size={12} />{" "}
          {translate("Updated {date}", { date: formatDate(new Date(c.updated)) })}
        </p>
      )}
    </div>
  );
}

function fmtPartial(d: {
  year?: number;
  month?: number;
  day?: number;
  utc?: string;
}): string {
  if (d.utc) return formatDate(new Date(d.utc));
  if (d.year && d.month && d.day)
    return formatDateLong(new Date(d.year, d.month - 1, d.day));
  if (d.month && d.day) return formatDateLong(new Date(2000, d.month - 1, d.day), false);
  return [d.year, d.month, d.day].filter(Boolean).join("-");
}
