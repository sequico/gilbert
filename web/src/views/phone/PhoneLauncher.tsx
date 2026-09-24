import { Delete, Mic, MicOff, Phone, PhoneCall, PhoneOff, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { contactDisplayName } from "@/lib/contacts";
import { plural, t } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import {
  allDialerCards,
  type DialerSource,
  dialerSources,
  dialTarget,
} from "@/lib/phone/dialer";
import { startRing, stopRing } from "@/lib/phone/ringtone";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { usePhone } from "@/store/phone";
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
 * surface and asks for the microphone — a gesture, as the browser requires —
 * and an incoming call announces itself as a banner under the top bar. A live
 * call is never modal: the reader keeps working and the entry carries it.
 *
 * It is offered only where it can work: the entry is absent until the tab holds
 * the seat, the account is registered and the bridge's media has answered. The
 * surface says what is missing rather than pretending.
 */
export function PhoneLauncher() {
  const isMobile = useIsMobile();
  const ready = usePhone((s) => s.ready);
  const state = usePhone((s) => s.state);
  const incoming = usePhone((s) => s.incoming);
  const call = usePhone((s) => s.call);
  const stream = usePhone((s) => s.stream);
  const muted = usePhone((s) => s.muted);
  const error = usePhone((s) => s.error);
  const microphone = usePhone((s) => s.microphone);
  const [open, setOpen] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  // The reader's own notification setting decides whether a call is heard.
  const notificationSound = useSettings((s) => s.settings.notificationSound);

  /*
   * The launcher is mounted for the session's life: it asks for the seat when
   * it appears and gives it up when the shell unmounts, which is what a sign-out
   * does. Closing the tab releases the lock with the page.
   */
  useEffect(() => {
    void usePhone.getState().start();
    return () => void usePhone.getState().stop();
  }, []);

  /* The peer's audio, played while there is one and stopped when there is not. */
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) void el.play().catch(() => undefined);
    else el.pause();
  }, [stream, ready]);

  /* The ring, only if this page is not silenced. */
  useEffect(() => {
    if (incoming && notificationSound) {
      startRing();
      return stopRing;
    }
    stopRing();
    return undefined;
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

  const colour = call
    ? "var(--success)"
    : state === "unavailable"
      ? "var(--danger)"
      : undefined;

  if (!ready) return null;

  /*
   * A red handset carries why, so the reader does not open it to find out: the
   * cause names which leg failed — Gilbert's to the SIP provider, or the
   * browser's to Gilbert — because the two are fixed by different people.
   */
  const label = state === "unavailable" && error ? error : t("Phone");

  return (
    <>
      <button
        className="icon-btn"
        aria-label={label}
        title={label}
        style={colour ? { color: colour } : undefined}
        onClick={() => {
          setOpen(true);
          // The permission is asked in its own gesture. The answer is kept, so
          // the surface can say what is missing without asking again.
          void usePhone.getState().requestMicrophone();
        }}
      >
        {call || incoming ? <PhoneCall size={21} /> : <Phone size={21} />}
      </button>
      <audio ref={audioRef} autoPlay playsInline hidden />

      {/* An incoming call: the screen on a phone, a dialog on a desktop. */}
      <Dialog
        open={Boolean(incoming)}
        onClose={() => void usePhone.getState().decline()}
        title={t("Incoming call")}
        size={isMobile ? "lg" : "sm"}
      >
        <p className="lead" style={{ textAlign: "center" }}>
          {incoming || t("Unknown caller")}
        </p>
        <div className="row" style={{ justifyContent: "center", gap: 12 }}>
          <button className="btn" onClick={() => void usePhone.getState().answer()}>
            {t("Answer")}
          </button>
          <button
            className="btn btn-danger"
            onClick={() => void usePhone.getState().decline()}
          >
            {t("Decline")}
          </button>
        </div>
      </Dialog>

      {/* The call surface: the dialer, or the live call's controls. */}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={call ? t("Call") : t("Phone")}
        size={isMobile ? "lg" : "md"}
      >
        <MicrophoneNotice microphone={microphone} />
        {error && <div className="error-box">{error}</div>}
        {call ? (
          <CallControls remote={call.remote} muted={muted} />
        ) : (
          <Dialer onDial={() => setOpen(false)} />
        )}
      </Dialog>
    </>
  );
}

/**
 * What the surface says about the microphone, and the one button that asks.
 *
 * A browser's own permission state is not readable everywhere, and the answer
 * only arrives when it is asked for: so the surface says what is missing and
 * offers the gesture, on a phone and on a desktop alike.
 */
function MicrophoneNotice({
  microphone,
}: {
  microphone: "granted" | "denied" | "prompt" | "unknown";
}) {
  if (microphone === "granted") return null;
  if (microphone === "unknown")
    return (
      <p className="hint">
        {t(
          "Grant the microphone in the browser's site settings to make calls; on some devices the browser asks the first time you place one.",
        )}
      </p>
    );
  return (
    <div className="warn-box">
      {microphone === "denied"
        ? t(
            "The microphone is not available, so calls cannot carry your voice. Grant the permission in the browser's site settings and try again.",
          )
        : t("Allow the microphone so calls can carry your voice.")}{" "}
      <button
        className="btn btn-sm btn-ghost"
        onClick={() => void usePhone.getState().requestMicrophone()}
      >
        {microphone === "denied" ? t("Try again") : t("Allow microphone")}
      </button>
    </div>
  );
}

/** The controls of a live call: mute, a DTMF keypad, and hang up. */
function CallControls({ remote, muted }: { remote: string; muted: boolean }) {
  const [tones, setTones] = useState("");
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
    </div>
  );
}

/** The dialer: search, a keypad to compose a number, and the separated contacts. */
function Dialer({ onDial }: { onDial: () => void }) {
  // Individual selections, not the whole store: the dialer rebuilds its sources
  // when the cards it reads change, and for nothing else.
  const cards = useContacts((s) => s.cards);
  const sharedBooks = useContacts((s) => s.sharedBooks);
  const cardsIn = useContacts((s) => s.cardsIn);
  const filterCards = useContacts((s) => s.filterCards);
  const ownAccountId = useContacts((s) => s.accountId) ?? "own";
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
  const ownCards = useMemo(() => Object.values(cards), [cards]);
  const sources: DialerSource[] = useMemo(
    () =>
      dialerSources({
        ownCards,
        sharedBooks,
        cardsIn,
        groups,
        personalLabel: t("Personal"),
        ownAccountId,
      }),
    [ownCards, sharedBooks, cardsIn, groups, ownAccountId],
  );

  const dial = (target: string) => {
    if (!target) return;
    void usePhone.getState().dial(target);
    onDial();
  };

  /*
   * A contact with no number is not offered as a call, and a source with none
   * is not a section: an empty "No contacts" heading under a group is noise
   * rather than information.
   */
  const filtered = (
    query.trim()
      ? sources.map((source) => ({
          ...source,
          cards: filterCards(source.cards, query).filter((c) => dialTarget(c)),
        }))
      : sources.map((source) => ({
          ...source,
          cards: source.cards.filter((c) => dialTarget(c)),
        }))
  ).filter((source) => source.cards.length > 0);
  const all = filterCards(allDialerCards(sources), query).filter((c) => dialTarget(c));

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
          {source.cards.slice(0, 50).map((card) => {
            const target = dialTarget(card);
            return (
              <button
                key={`${source.accountId}:${card.id}`}
                className="nav-item"
                onClick={() => target && dial(target)}
                style={{ width: "100%", textAlign: "start" }}
              >
                <PhoneCall size={15} />
                <span className="grow truncate">{contactDisplayName(card)}</span>
                {target && <span className="hint truncate">{target}</span>}
              </button>
            );
          })}
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
      {!filtered.length && (
        <p className="hint" style={{ padding: "2px 12px" }}>
          {t("No contacts with a number to call.")}
        </p>
      )}
    </div>
  );
}
