/**
 * The microphone permission (ADR 0023).
 *
 * Asked for as early as the surface can, in its own gesture, by the same
 * principle the notification permission already follows: a permission asked
 * silently is one nobody grants, and one deferred to the first call is a call
 * that fails at the worst moment. The tracks are stopped at once — this asks
 * for the permission and keeps nothing open.
 */

export type MicrophoneState = "granted" | "denied";

export async function ensureMicrophone(): Promise<MicrophoneState> {
  try {
    if (!navigator.mediaDevices?.getUserMedia) return "denied";
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return "granted";
  } catch {
    return "denied";
  }
}
