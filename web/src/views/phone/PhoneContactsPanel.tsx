import { Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { contactDisplayName } from "@/lib/contacts";
import { t } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { type DialerSource, dialerSources, dialTarget } from "@/lib/phone/dialer";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { usePhone } from "@/store/phone";
import { Avatar } from "@/ui/misc";

/**
 * The phone's contacts, the panel beside the dialer (ADR 0023).
 *
 * Two status rows say what is true of the line — the browser's path to Gilbert,
 * and this account's registration — and the tabs choose which contacts the list
 * below offers: everything, the installation's directory, the reader's own, or
 * one of the groups they belong to. A search narrows what is shown, and the
 * list is the tab and the search together, live.
 */

/** The fixed tabs, before the group rows: every kind a source can be. */
const FIXED_TABS = [
  { id: "all", label: "All" },
  { id: "global", label: "Global" },
  { id: "personal", label: "My" },
];

/** Whether a source belongs under the selected tab. */
function inTab(source: DialerSource, tab: string): boolean {
  if (tab === "all") return true;
  if (tab.startsWith("group:"))
    return source.kind === "group" && `group:${source.accountId}` === tab;
  return source.kind === tab;
}

export function PhoneContactsPanel() {
  // Individual selections, not the whole store: the panel rebuilds its sources
  // when the cards it reads change, and for nothing else.
  const cards = useContacts((s) => s.cards);
  const sharedBooks = useContacts((s) => s.sharedBooks);
  const cardsIn = useContacts((s) => s.cardsIn);
  const filterCards = useContacts((s) => s.filterCards);
  const ownAccountId = useContacts((s) => s.accountId) ?? "own";
  const mailAccounts = useMail((s) => s.mailAccounts);
  const ready = usePhone((s) => s.ready);
  const line = usePhone((s) => s.state);
  const mediaReason = usePhone((s) => s.mediaReason);
  const sipReason = usePhone((s) => s.sipReason);
  const [tab, setTab] = useState("all");
  const [query, setQuery] = useState("");

  const groups = useMemo(
    () =>
      groupMailboxAccounts(mailAccounts).map((g) => ({
        id: `group:${g.accountId}`,
        accountId: g.accountId,
        label: g.name,
      })),
    [mailAccounts],
  );
  const ownCards = useMemo(() => Object.values(cards), [cards]);
  const sources: DialerSource[] = useMemo(
    () =>
      dialerSources({
        ownCards,
        sharedBooks,
        cardsIn,
        groups: groups.map((g) => ({ accountId: g.accountId, name: g.label })),
        personalLabel: t("Personal"),
        ownAccountId,
      }),
    [ownCards, sharedBooks, cardsIn, groups, ownAccountId],
  );

  /*
   * The list the panel shows: the selected tab, the search over it, and no card
   * twice — a card filed in two books is one row, keyed by its account and id.
   */
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ key: string; card: (typeof ownCards)[number] }> = [];
    for (const source of sources.filter((s) => inTab(s, tab))) {
      const picked = query.trim() ? filterCards(source.cards, query) : source.cards;
      for (const card of picked) {
        const key = `${source.accountId}:${card.id}`;
        if (seen.has(key) || !dialTarget(card)) continue;
        seen.add(key);
        out.push({ key, card });
      }
    }
    return out;
  }, [sources, tab, query, filterCards]);

  return (
    <div className="phone-contacts-panel">
      <div className="phone-status">
        <div
          className="phone-status-row"
          title={
            ready
              ? t("This browser reaches Gilbert: the phone's media path is proven.")
              : (mediaReason ??
                t(
                  "Not proven: this browser has not carried the phone's media to Gilbert — the bridge's media ports may be closed.",
                ))
          }
        >
          <span className={`phone-dot ${ready ? "ok" : "bad"}`} aria-hidden />
          <span className="grow truncate">{t("Gilbert connection")}</span>
        </div>
        <div
          className="phone-status-row"
          title={
            line === "registered"
              ? t("Registered with the SIP provider.")
              : (sipReason ?? t("Not registered with the SIP provider."))
          }
        >
          <span className={`phone-dot ${line === "registered" ? "ok" : "bad"}`} aria-hidden />
          <span className="grow truncate">{t("SIP connection")}</span>
        </div>
      </div>

      <div className="phone-tabs" role="tablist" aria-label={t("Contacts")}>
        {FIXED_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={`phone-tab ${tab === entry.id ? "active" : ""}`}
            onClick={() => setTab(entry.id)}
          >
            {t(entry.label)}
          </button>
        ))}
      </div>
      {groups.map((group) => (
        <button
          key={group.id}
          type="button"
          role="tab"
          aria-selected={tab === group.id}
          className={`phone-tab-row ${tab === group.id ? "active" : ""}`}
          onClick={() => setTab(group.id)}
        >
          {group.label}
        </button>
      ))}

      <div className="phone-search">
        <Search size={14} className="faint" />
        <input
          className="phone-search-input"
          placeholder={t("Search contacts")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t("Search contacts")}
        />
        {query && (
          <button
            type="button"
            className="phone-search-clear"
            aria-label={t("Clear")}
            onClick={() => setQuery("")}
          >
            <X size={14} />
          </button>
        )}
      </div>

      <div className="phone-contact-list">
        {rows.map(({ key, card }) => {
          const target = dialTarget(card);
          return (
            <button
              key={key}
              type="button"
              className="dialer-contact"
              onClick={() => target && void usePhone.getState().dial(target)}
            >
              <Avatar
                who={{
                  name: contactDisplayName(card),
                  email: Object.values(card.emails ?? {})[0]?.address,
                }}
                size="sm"
              />
              <span className="grow truncate">{contactDisplayName(card)}</span>
              {target && <span className="hint truncate">{target}</span>}
            </button>
          );
        })}
        {!rows.length && (
          <p className="hint" style={{ padding: "4px 6px" }}>
            {t("No contacts with a number to call.")}
          </p>
        )}
      </div>
    </div>
  );
}
