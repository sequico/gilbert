/**
 * The microphone permission (ADR 0023).
 *
 * Asked for as early as the surface can, in its own gesture, by the same
 * principle the notification permission already follows: a permission asked
 * silently is one nobody grants, and one deferred to the first call is a call
 * that fails at the worst moment. `microphoneState` reads the browser's answer
 * without prompting, so the surface can ask only when it has to and can say
 * what is missing when it cannot; the read of the permission's own state is not
 * available everywhere (iOS Safari refuses it), which is why the surface also
 * offers a button that asks. The tracks are stopped at once — this asks for the
 * permission and keeps nothing open.
 */

/** What the app knows about the microphone. */
export type MicrophonePermission = "granted" | "denied" | "prompt" | "unknown";

/** The browser's own answer, without prompting; `unknown` where it will not say. */
export async function microphoneState(): Promise<MicrophonePermission> {
  try {
    if (!navigator.permissions?.query) return "unknown";
    const status = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    if (status.state === "granted") return "granted";
    if (status.state === "denied") return "denied";
    return "prompt";
  } catch {
    return "unknown";
  }
}

/** Ask for the microphone, in this gesture. The tracks are stopped at once. */
export async function requestMicrophone(): Promise<"granted" | "denied"> {
  try {
    if (!navigator.mediaDevices?.getUserMedia) return "denied";
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return "granted";
  } catch {
    return "denied";
  }
}
