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
import { Popover, useMenu } from "@/ui/popover";

/** The digits the keypad offers, in the order a phone lays them out. */
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

/** The letters a key carries, printed under its digit as a phone prints them. */
const KEY_LETTERS: Record<string, string> = {
  "2": "ABC",
  "3": "DEF",
  "4": "GHI",
  "5": "JKL",
  "6": "MNO",
  "7": "PQRS",
  "8": "TUV",
  "9": "WXYZ",
  "0": "+",
};

/**
 * The phone in the top-bar action cluster (ADR 0023).
 *
 * The entry is the feature's whole presence until it is pressed: its colour is
 * the line's state and it returns to idle on its own. A press opens the call
 * surface **attached to the handset** — not a dialog in the middle of the
 * screen — and an incoming call announces itself as a banner under the top bar.
 * A live call is never modal: the reader keeps working and the entry carries it.
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
  const panel = useMenu();
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

  /*
   * The microphone is asked for by the product, not by the reader finding a
   * button. A browser prompts only inside a user gesture, so the first gesture
   * anywhere in the app is taken as the moment — asking on load, outside one,
   * is granted by nobody. The listener is disarmed once the browser answers.
   */
  useEffect(() => {
    if (microphone === "granted" || microphone === "denied") return;
    const ask = () => {
      window.removeEventListener("pointerdown", ask);
      window.removeEventListener("keydown", ask);
      void usePhone.getState().requestMicrophone();
    };
    window.addEventListener("pointerdown", ask);
    window.addEventListener("keydown", ask);
    return () => {
      window.removeEventListener("pointerdown", ask);
      window.removeEventListener("keydown", ask);
    };
  }, [microphone]);

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
        aria-haspopup="dialog"
        style={colour ? { color: colour } : undefined}
        onClick={(event) => {
          panel.open(event);
          if (microphone !== "granted") void usePhone.getState().requestMicrophone();
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

      {/* The call surface: attached to the handset that opened it. */}
      <Popover
        anchor={panel.anchor}
        onClose={panel.close}
        trigger={panel.trigger}
        align="end"
        role="dialog"
        ariaLabel={call ? t("Call") : t("Phone")}
        width={300}
        style={{ padding: 10 }}
      >
        <MicrophoneNotice microphone={microphone} />
        {error && <div className="error-box">{error}</div>}
        {call ? (
          <CallControls remote={call.remote} muted={muted} />
        ) : (
          <Dialer onDial={panel.close} />
        )}
      </Popover>
    </>
  );
}

/**
 * What the surface says about the microphone.
 *
 * The permission is asked for automatically at the first gesture, so nothing
 * here is a step the reader has to take — except when the browser is already
 * blocking it, where only they can open the door again.
 */
function MicrophoneNotice({
  microphone,
}: {
  microphone: "granted" | "denied" | "prompt" | "unknown";
}) {
  if (microphone === "granted") return null;
  if (microphone === "denied")
    return (
      <div className="warn-box">
        {t(
          "Your browser is blocking the microphone for this site, so a call cannot carry your voice. Allow it for this site, then try again.",
        )}{" "}
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => void usePhone.getState().requestMicrophone()}
        >
          {t("Try again")}
        </button>
      </div>
    );
  return (
    <p className="hint">
      {t(
        "The microphone is asked for the first time you touch the page; allow it so a call can carry your voice.",
      )}
    </p>
  );
}

/** The controls of a live call: mute, a DTMF keypad, and hang up. */
function CallControls({ remote, muted }: { remote: string; muted: boolean }) {
  const [tones, setTones] = useState("");
  return (
    <div className="call-panel">
      <p className="call-who">{remote}</p>
      <div className="call-actions">
        <button
          className="call-action"
          onClick={() => usePhone.getState().setMuted(!muted)}
          aria-label={muted ? t("Unmute") : t("Mute")}
        >
          {muted ? <MicOff size={19} /> : <Mic size={19} />}
          {muted ? t("Unmute") : t("Mute")}
        </button>
        <button
          className="call-action call-hangup"
          onClick={() => void usePhone.getState().hangup()}
        >
          <PhoneOff size={19} /> {t("Hang up")}
        </button>
      </div>
      <div className="dialpad">
        {KEYS.map((key) => (
          <button
            type="button"
            key={key}
            className="dialpad-key"
            onClick={() => {
              usePhone.getState().sendDtmf(key);
              setTones((v) => v + key);
            }}
          >
            <span className="dialpad-digit">{key}</span>
          </button>
        ))}
      </div>
      {tones && <p className="call-tones">{tones}</p>}
    </div>
  );
}

/** The dialer: a keypad to compose a number, and the contacts to dial instead. */
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
    <div className="dialer">
      <div className="dialer-display">
        <input
          className="dialer-number"
          placeholder={t("Number or address")}
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") dial(number.trim());
          }}
          inputMode="tel"
          autoComplete="off"
          aria-label={t("Number or address")}
        />
        <button
          type="button"
          className="dialer-back"
          aria-label={t("Delete")}
          disabled={!number}
          onClick={() => setNumber((v) => v.slice(0, -1))}
        >
          <Delete size={18} />
        </button>
      </div>

      <div className="dialpad">
        {KEYS.map((key) => (
          <button
            type="button"
            key={key}
            className="dialpad-key"
            onClick={() => setNumber((v) => v + key)}
          >
            <span className="dialpad-digit">{key}</span>
            {KEY_LETTERS[key] && (
              <span className="dialpad-letters">{KEY_LETTERS[key]}</span>
            )}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="dialer-call"
        disabled={!number.trim()}
        onClick={() => dial(number.trim())}
        aria-label={t("Call")}
      >
        <PhoneCall size={24} />
      </button>

      <div className="dialer-contacts">
        <div className="dialer-search">
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
                  type="button"
                  key={`${source.accountId}:${card.id}`}
                  className="dialer-contact"
                  onClick={() => target && dial(target)}
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
    </div>
  );
}
