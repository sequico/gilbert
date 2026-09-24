import { Delete, Mic, MicOff, Phone, PhoneCall, PhoneOff, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { contactDisplayName } from "@/lib/contacts";
import { plural, t } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { dialTarget } from "@/lib/phone/config";
import { allDialerCards, type DialerSource, dialerSources } from "@/lib/phone/dialer";
import { startRing, stopRing } from "@/lib/phone/ringtone";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { usePhone } from "@/store/phone";
import { useSession } from "@/store/session";
import { useSettings } from "@/store/settings";
import { Dialog } from "@/ui/dialog";
import { useIsMobile } from "@/ui/misc";

/** The digits the keypad offers, in the order a phone lays them out. */
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

/**
 * The phone in the top-bar action cluster (ADR 0023).
 *
 * The entry is the feature's whole presence until it is pressed: its colour is
 * the line's state and it returns to idle on its own. A press opens the call
 * surface — the dialer when nothing is live, the call's controls when something
 * is — and an incoming call takes the screen on a phone and a banner on a
 * desktop. A live call is never modal: the reader keeps working and the entry
 * carries the call.
 *
 * What it cannot do is stated rather than pretended: the entry is absent when
 * the installation offers no phone or this account has no credential, and a
 * standby tab (one that does not hold the line) shows the call without owning
 * its controls.
 */
export function PhoneLauncher() {
  const isMobile = useIsMobile();
  const ready = usePhone((s) => s.ready);
  const state = usePhone((s) => s.state);
  const incoming = usePhone((s) => s.incoming);
  const call = usePhone((s) => s.call);
  const held = usePhone((s) => s.held);
  const stream = usePhone((s) => s.stream);
  const muted = usePhone((s) => s.muted);
  const error = usePhone((s) => s.error);
  const start = usePhone((s) => s.start);
  const [open, setOpen] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  const session = useSession((s) => s.session);
  const sipOffered = Boolean(session?.gilbert?.sip?.enabled);
  // The reader's own notification setting decides whether a call is heard.
  const notificationSound = useSettings((s) => s.settings.notificationSound);

  useEffect(() => {
    if (sipOffered) void start();
  }, [sipOffered, start]);

  /* The peer's audio. The stream arrives once the call is established. */
  useEffect(() => {
    const el = audioRef.current;
    if (el && stream && el.srcObject !== stream) {
      el.srcObject = stream;
      void el.play().catch(() => undefined);
    }
  }, [stream]);

  /* The ring: audible only when the reader has not silenced Gilbert. */
  useEffect(() => {
    if (incoming && notificationSound) {
      startRing();
      return stopRing;
    }
    stopRing();
  }, [incoming, notificationSound]);

  /*
   * A full reload tears the media stack down, so a call cannot survive one.
   * The browser's own confirmation is the only door: this asks for it while a
   * call is live and does nothing once it is over.
   */
  useEffect(() => {
    if (!call) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [call]);

  const colour =
    call && state !== "standby"
      ? "var(--success)"
      : state === "unavailable" || state === "standby"
        ? "var(--danger)"
        : undefined;

  if (!ready) return null;

  return (
    <>
      <button
        className="icon-btn"
        aria-label={t("Phone")}
        title={t("Phone")}
        style={colour ? { color: colour } : undefined}
        onClick={() => setOpen(true)}
      >
        {call || incoming ? <PhoneCall size={21} /> : <Phone size={21} />}
      </button>
      <audio ref={audioRef} autoPlay playsInline hidden />

      {/* An incoming call: the screen on a phone, a dialog on a desktop. */}
      <Dialog
        open={Boolean(incoming)}
        onClose={() => void usePhone.getState().decline()}
        title={call ? t("Call waiting") : t("Incoming call")}
        size={isMobile ? "lg" : "sm"}
      >
        <p className="lead" style={{ textAlign: "center" }}>
          {incoming || t("Unknown caller")}
        </p>
        <div className="row" style={{ justifyContent: "center", gap: 12 }}>
          {state !== "standby" && (
            <>
              <button className="btn" onClick={() => void usePhone.getState().answer()}>
                {t("Answer")}
              </button>
              <button
                className="btn btn-danger"
                onClick={() => void usePhone.getState().decline()}
              >
                {t("Decline")}
              </button>
            </>
          )}
          {state === "standby" && (
            <p className="hint">{t("Answering in another tab.")}</p>
          )}
        </div>
      </Dialog>

      {/* The call surface: the dialer, or the live call's controls. */}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={call ? t("Call") : t("Phone")}
        size={isMobile ? "lg" : "md"}
      >
        {error && <div className="error-box">{error}</div>}
        {call ? (
          <CallControls
            remote={call.remote}
            muted={muted}
            held={held}
            onSwitch={(remote) => usePhone.getState().switchTo(remote)}
            readOnly={state === "standby"}
          />
        ) : (
          <Dialer onDial={() => setOpen(false)} />
        )}
      </Dialog>
    </>
  );
}

/** The controls of a live call: mute, a DTMF keypad, and hang up. */
function CallControls({
  remote,
  muted,
  held,
  onSwitch,
  readOnly,
}: {
  remote: string;
  muted: boolean;
  held: string[];
  onSwitch: (remote: string) => void;
  readOnly: boolean;
}) {
  const [tones, setTones] = useState("");
  if (readOnly)
    return (
      <div>
        <p className="lead" style={{ textAlign: "center" }}>
          {remote}
        </p>
        <p className="hint" style={{ textAlign: "center" }}>
          {t("This call is answered in another tab.")}
        </p>
      </div>
    );
  return (
    <div>
      <p className="lead" style={{ textAlign: "center" }}>
        {remote}
      </p>
      <div className="row" style={{ justifyContent: "center", gap: 8 }}>
        <button
          className="btn btn-ghost"
          onClick={() => usePhone.getState().setMuted(!muted)}
          aria-label={muted ? t("Unmute") : t("Mute")}
        >
          {muted ? <MicOff size={18} /> : <Mic size={18} />}
          {muted ? t("Unmute") : t("Mute")}
        </button>
        <button
          className="btn btn-danger"
          onClick={() => void usePhone.getState().hangup()}
        >
          <PhoneOff size={18} /> {t("Hang up")}
        </button>
      </div>
      <div className="dialpad">
        {KEYS.map((key) => (
          <button
            key={key}
            className="btn btn-ghost dialpad-key"
            onClick={() => {
              usePhone.getState().sendDtmf(key);
              setTones((v) => v + key);
            }}
          >
            {key}
          </button>
        ))}
      </div>
      {tones && (
        <p className="hint" style={{ textAlign: "center" }}>
          {tones}
        </p>
      )}
      {/* Calls waiting while this one is active (ADR 0023): the reader switches
          between them rather than losing either. */}
      {held.length > 0 && (
        <div>
          <div className="nav-section">
            <span>{t("On hold")}</span>
          </div>
          {held.map((other) => (
            <button
              key={other}
              className="nav-item"
              style={{ width: "100%", textAlign: "start" }}
              onClick={() => onSwitch(other)}
            >
              <PhoneCall size={15} />
              <span className="grow truncate">{other}</span>
              <span className="hint">{t("Switch")}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The dialer: search, a keypad to compose a number, and the separated contacts. */
function Dialer({ onDial }: { onDial: () => void }) {
  const contacts = useContacts();
  const mailAccounts = useMail((s) => s.mailAccounts);
  const [query, setQuery] = useState("");
  const [number, setNumber] = useState("");

  const groups = useMemo(
    () =>
      groupMailboxAccounts(mailAccounts).map((g) => ({
        accountId: g.accountId,
        name: g.name,
      })),
    [mailAccounts],
  );
  const ownCards = useMemo(() => Object.values(contacts.cards), [contacts.cards]);
  const sources: DialerSource[] = useMemo(
    () =>
      dialerSources({
        ownCards,
        sharedBooks: contacts.sharedBooks,
        cardsIn: (accountId) => contacts.cardsIn(accountId),
        groups,
        personalLabel: t("Personal"),
      }),
    [ownCards, contacts, groups],
  );

  const dial = (target: string) => {
    if (!target) return;
    void usePhone.getState().dial(target);
    onDial();
  };

  const filtered = query.trim()
    ? sources.map((source) => ({
        ...source,
        cards: contacts.filterCards(source.cards, query),
      }))
    : sources;
  const all = contacts.filterCards(allDialerCards(sources), query);

  return (
    <div>
      {/* Compose a number by hand, so the phone is not limited to Contacts. */}
      <div className="row" style={{ gap: 6 }}>
        <input
          className="input grow"
          placeholder={t("Number or address")}
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") dial(number.trim());
          }}
        />
        <button
          className="icon-btn sm"
          aria-label={t("Delete")}
          onClick={() => setNumber((v) => v.slice(0, -1))}
        >
          <Delete size={16} />
        </button>
        <button
          className="btn"
          disabled={!number.trim()}
          onClick={() => dial(number.trim())}
        >
          <PhoneCall size={16} /> {t("Call")}
        </button>
      </div>
      <div className="dialpad">
        {KEYS.map((key) => (
          <button
            key={key}
            className="btn btn-ghost dialpad-key"
            onClick={() => setNumber((v) => v + key)}
          >
            {key}
          </button>
        ))}
      </div>
      <div className="row">
        <Search size={15} className="faint" />
        <input
          className="input grow"
          placeholder={t("Search contacts")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {filtered.map((source) => (
        <div key={source.id}>
          <div className="nav-section">
            <span>{source.label}</span>
          </div>
          {source.cards.length === 0 ? (
            <p className="hint" style={{ padding: "2px 12px" }}>
              {t("No contacts")}
            </p>
          ) : (
            source.cards.slice(0, 50).map((card) => {
              const target = dialTarget(card);
              return (
                <button
                  key={`${source.id}:${card.id}`}
                  className="nav-item"
                  disabled={!target}
                  onClick={() => target && dial(target)}
                  style={{ width: "100%", textAlign: "start" }}
                >
                  <PhoneCall size={15} className={target ? "" : "faint"} />
                  <span className="grow truncate">{contactDisplayName(card)}</span>
                  {target && <span className="hint truncate">{target}</span>}
                </button>
              );
            })
          )}
        </div>
      ))}
      {query.trim() && (
        <>
          <div className="nav-section">
            <span>{t("All")}</span>
          </div>
          <p className="hint" style={{ padding: "2px 12px" }}>
            {plural(all.length, { one: "{n} contact", other: "{n} contacts" })}
          </p>
        </>
      )}
      {!sources.length && <p className="hint">{t("No contacts")}</p>}
    </div>
  );
}
