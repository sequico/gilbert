/**
 * The ring of an incoming call (ADR 0023).
 *
 * A short tone from the Web Audio API rather than a shipped audio file: the
 * product carries no ring asset to keep in step with anything, and a browser
 * that refuses to make one leaves the visual ring, which is the surface that
 * never fails. It is started and stopped by the launcher, and the reader's
 * notification setting already decides whether it is heard at all.
 */

let context: AudioContext | null = null;
let timer: number | null = null;

/** One tone: two short bursts, which read as a ring rather than a beep. */
function ringOnce(ctx: AudioContext): void {
  for (const at of [0, 0.5]) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 440;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.4);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(ctx.currentTime + at);
    oscillator.stop(ctx.currentTime + at + 0.45);
  }
}

/** Begin ringing, repeating until stopped. Safe to call more than once. */
export function startRing(): void {
  stopRing();
  try {
    const Ctor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    context ??= new Ctor();
    const ctx = context;
    void ctx.resume().catch(() => undefined);
    ringOnce(ctx);
    timer = window.setInterval(() => {
      if (context) ringOnce(context);
    }, 2000);
  } catch {
    /* No audio context: the visual ring is what is left, and it is enough. */
  }
}

/** Stop ringing. */
export function stopRing(): void {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}
