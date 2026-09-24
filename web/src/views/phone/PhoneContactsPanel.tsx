import { Users, X } from "lucide-react";
import { useMemo, useState } from "react";
import { contactDisplayName } from "@/lib/contacts";
import { t } from "@/lib/i18n";
import { contactNumbers, type DialerSource } from "@/lib/phone/dialer";
import { useContacts } from "@/store/contacts";
import { usePhone } from "@/store/phone";
import { Avatar } from "@/ui/misc";
import { usePhoneSources } from "./usePhoneSources";

/**
 * The phone's contacts, the pane beside the dialer (ADR 0023).
 *
 * Two status rows say what is true of the line — the browser's path to Gilbert,
 * and this account's registration — each with its cause on hover. The tabs
 * choose which contacts the list offers: everything, the installation's
 * directory, the reader's own, or one of the groups they belong to. A search
 * narrows it, and each number a contact carries is offered with its type, so
 * "mobile" and "work" are not the same button.
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
  const filterCards = useContacts((s) => s.filterCards);
  const ready = usePhone((s) => s.ready);
  const line = usePhone((s) => s.state);
  const mediaReason = usePhone((s) => s.mediaReason);
  const sipReason = usePhone((s) => s.sipReason);
  const { sources, groups } = usePhoneSources();
  const [tab, setTab] = useState("all");
  const [query, setQuery] = useState("");

  /*
   * The list the pane shows: the selected tab, the search over it, and no card
   * twice — a card filed in two books is one row, keyed by its account and id.
   * Every contact is listed; only the ones with a number offer a call, because a
   * contact with no number is still somebody the reader may look for.
   */
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ key: string; card: (typeof sources)[number]["cards"][number] }> =
      [];
    for (const source of sources.filter((s) => inTab(s, tab))) {
      const picked = query.trim() ? filterCards(source.cards, query) : source.cards;
      for (const card of picked) {
        const key = `${source.accountId}:${card.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ key, card });
      }
    }
    return out;
  }, [sources, tab, query, filterCards]);

  return (
    <div className="phone-pane phone-contacts-panel">
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
          <span className="grow truncate">{t("Gilbert phone connection")}</span>
        </div>
        <div
          className="phone-status-row"
          title={
            line === "registered"
              ? t("Registered with the SIP provider.")
              : (sipReason ?? t("Not registered with the SIP provider."))
          }
        >
          <span
            className={`phone-dot ${line === "registered" ? "ok" : "bad"}`}
            aria-hidden
          />
          <span className="grow truncate">{t("SIP server connection")}</span>
        </div>
      </div>

      <div className="tabs phone-tabs" role="tablist" aria-label={t("Contacts")}>
        {FIXED_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className="tab"
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
          className={`phone-group ${tab === group.id ? "active" : ""}`}
          onClick={() => setTab(group.id)}
        >
          <Users size={15} />
          <span className="grow truncate">{group.label}</span>
        </button>
      ))}

      <div className="phone-search">
        <input
          className="input"
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
        {rows.map(({ key, card }) => (
          <div key={key} className="phone-contact">
            <Avatar
              who={{
                name: contactDisplayName(card),
                email: Object.values(card.emails ?? {})[0]?.address,
              }}
              size="sm"
            />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="phone-contact-name truncate">
                {contactDisplayName(card)}
              </div>
              {contactNumbers(card).map((number) => (
                <button
                  key={number.number}
                  type="button"
                  className="phone-contact-number"
                  onClick={() => void usePhone.getState().dial(number.number)}
                >
                  {number.label && <span className="hint">{number.label}</span>}
                  <span className="truncate">{number.number}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
        {!rows.length && (
          <p className="hint" style={{ padding: "4px 6px" }}>
            {t("No contacts.")}
          </p>
        )}
      </div>
    </div>
  );
}
