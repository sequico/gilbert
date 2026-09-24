import { Delete, Mic, MicOff, Phone, PhoneCall, PhoneOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { startRing, stopRing } from "@/lib/phone/ringtone";
import { usePhone } from "@/store/phone";
import { useSettings } from "@/store/settings";
import { Dialog } from "@/ui/dialog";
import { useIsMobile, useIsTouch } from "@/ui/misc";
import { Popover, useMenu } from "@/ui/popover";
import { CallLogPanel } from "./CallLogPanel";
import { PhoneContactsPanel } from "./PhoneContactsPanel";

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
 * surface **attached to the handset** — a wide panel with the contacts on the
 * left, the dialer in the centre and the account's call log on the right — and
 * an incoming call announces itself as a banner under the top bar. A live call
 * is never modal: the reader keeps working and the entry carries it.
 *
 * It is offered only where it can work: the entry is absent until the tab holds
 * the seat, the account is registered and the bridge's media has answered. It is
 * also **desktop only**: a page suspended behind a locked screen cannot ring, so
 * on a touch device the entry is not offered at all — and nothing registers and
 * no microphone is asked for there.
 */
export function PhoneLauncher() {
  const isMobile = useIsMobile();
  const touch = useIsTouch();
  const sipUser = usePhone((s) => s.sipUser);
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
    if (touch) return;
    void usePhone.getState().start();
    return () => void usePhone.getState().stop();
  }, [touch]);

  /*
   * The microphone is asked for by the product, not by the reader finding a
   * button. A browser prompts only inside a user gesture, so the first gesture
   * anywhere in the app is taken as the moment — asking on load, outside one,
   * is granted by nobody. The listener is disarmed once the browser answers.
   */
  useEffect(() => {
    if (touch || microphone !== "unknown") return;
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
  }, [microphone, touch]);

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

  if (touch || !ready) return null;

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

      {/* The call surface: attached to the handset that opened it, three panes
          wide — the contacts, the dialer, the account's calls. */}
      <Popover
        anchor={panel.anchor}
        onClose={panel.close}
        trigger={panel.trigger}
        align="end"
        role="dialog"
        ariaLabel={call ? t("Call") : t("Phone")}
        width={860}
        style={{
          padding: 10,
          maxHeight: "calc(100vh - 16px)",
          maxWidth: "min(860px, calc(100vw - 16px))",
          overflow: "hidden",
        }}
      >
        <div className="phone-grid">
          <PhoneContactsPanel />
          <div className="phone-pane phone-center">
            <div className="phone-title">{sipUser}</div>
            {call ? (
              <CallControls remote={call.remote} muted={muted} />
            ) : (
              <Dialer onDial={panel.close} />
            )}
            <PhoneOverlay error={error} />
          </div>
          <CallLogPanel />
        </div>
      </Popover>
    </>
  );
}

/**
 * What the panel says when something failed — over the dialer, never in it.
 *
 * A message in the flow would push the keypad and the call button down and make
 * the panel scroll, and a message that takes the pointer swallows the presses
 * on the contacts underneath it. So the cause floats over the dialer's foot and
 * is read-only: every control keeps every press it had.
 */
function PhoneOverlay({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="phone-overlay">
      <div className="error-box">{error}</div>
    </div>
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

/** The dialer: the number the reader composes, and the one button that dials it. */
function Dialer({ onDial }: { onDial: () => void }) {
  const [number, setNumber] = useState("");
  const dial = (target: string) => {
    if (!target) return;
    void usePhone.getState().dial(target);
    onDial();
  };

  return (
    <div className="dialer">
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

      {/* The field the reader can type into, under the keys: the keypad is the
          phone's own entry, and this is for a number copied from somewhere. */}
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

      <button
        type="button"
        className="dialer-call"
        disabled={!number.trim()}
        onClick={() => dial(number.trim())}
        aria-label={t("Call")}
      >
        <PhoneCall size={24} />
      </button>
    </div>
  );
}
