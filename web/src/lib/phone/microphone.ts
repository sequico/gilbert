/**
 * The microphone (ADR 0023).
 *
 * One place opens it, classifies a refusal and names it, so the call surface,
 * the call itself and the panel cannot disagree about why a call has no voice.
 * The permission is asked for at the first gesture: a browser prompts inside
 * one, and one asked for outside it is granted by nobody.
 */
import { t } from "@/lib/i18n";

/** Why the microphone is not available, when it is not. */
export type MicrophoneReason = "blocked" | "no-device" | "unavailable";

/** What the app knows about the microphone: granted, a reason, or not yet asked. */
export type MicrophoneState = "granted" | MicrophoneReason | "unknown";

/** The tracks are stopped at once — this asks for the permission and keeps nothing. */
export async function requestMicrophone(): Promise<MicrophoneState> {
  const opened = await openMicrophone();
  if (!opened.ok) return opened.reason;
  for (const track of opened.stream.getTracks()) track.stop();
  return "granted";
}

/**
 * Open the microphone for a call, or say why it cannot be opened.
 *
 * Separate from `requestMicrophone` because a call keeps the stream: this hands
 * it back, and the caller is the one that ends it. The classification is here so
 * both callers read the browser's refusal the same way.
 */
export async function openMicrophone(): Promise<
  { ok: true; stream: MediaStream } | { ok: false; reason: MicrophoneReason }
> {
  if (!window.isSecureContext) return { ok: false, reason: "unavailable" };
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, reason: "unavailable" };
  try {
    return { ok: true, stream: await navigator.mediaDevices.getUserMedia({ audio: true }) };
  } catch (err) {
    return { ok: false, reason: reasonFrom(err) };
  }
}

/** One sentence per cause, so a refusal reads the same wherever it is shown. */
export function microphoneMessage(reason: MicrophoneReason): string {
  switch (reason) {
    case "blocked":
      return t(
        "Your browser is blocking the microphone for this site, so a call cannot carry your voice. Allow it for this site, then try again.",
      );
    case "no-device":
      return t(
        "No microphone is available on this device, so a call cannot carry your voice.",
      );
    case "unavailable":
      return t(
        "This browser cannot reach a microphone, so a call cannot carry your voice.",
      );
  }
}

/** The browser's own answer, without prompting; `unknown` where it will not say. */
export async function microphoneState(): Promise<MicrophoneState> {
  try {
    if (!navigator.permissions?.query) return "unknown";
    const status = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    if (status.state === "granted") return "granted";
    if (status.state === "denied") return "blocked";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** A `getUserMedia` refusal, named by what it means rather than its `name`. */
function reasonFrom(err: unknown): MicrophoneReason {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "blocked";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no-device";
  return "unavailable";
}
