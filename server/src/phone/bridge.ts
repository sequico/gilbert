/**
 * The phone's bridge, as gilbertserver reaches it (ADR 0023).
 *
 * The bridge is Janus with its SIP plugin, a second process of this same
 * release: beside the server inside the one image, or beside it on the host
 * when the installer is used. Either way it is on loopback, and its API is
 * never exposed — only gilbertserver proxies the browser's WebSocket to it.
 * Its media range and the ports an operator opens are the deployment's; the
 * one thing the administration states is that range,
 * `BRIDGE_MEDIA_PORTS` in `@gilbert/shared/phone`.
 *
 * The bridge is **optional**: a host that cannot build Janus installs Gilbert
 * without the phone, and `bridgeReachable` is how the administration knows to
 * say so.
 */
import { WebSocket } from "ws";

/** The bridge's WebSocket API, on loopback: it is a second process here. */
export const BRIDGE_URL = "ws://127.0.0.1:8188";

/** The subprotocol the Janus API requires on that socket. */
export const JANUS_PROTOCOL = "janus-protocol";

/** How long the bridge is given to answer the status probe. */
const PROBE_TIMEOUT_MS = 1500;

/** Whether the bridge is running, and the reason if it is not. */
export interface BridgeStatus {
  available: boolean;
  reason: string | null;
}

/**
 * Probe the bridge on loopback.
 *
 * A probe, not a setting: it says whether the daemon answers, which is what
 * lets the administration tell an operator the phone is unavailable and why.
 * Whether the **media** can flow is a separate fact, proven by the client
 * against the bridge before it offers the phone.
 */
export async function bridgeReachable(): Promise<BridgeStatus> {
  const socket = new WebSocket(BRIDGE_URL, JANUS_PROTOCOL);
  const reachable = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      socket.terminate();
      resolve(false);
    }, PROBE_TIMEOUT_MS);
    socket.on("open", () => {
      clearTimeout(timer);
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  socket.close();
  return reachable
    ? { available: true, reason: null }
    : {
        available: false,
        reason: "the phone's bridge is not running on this host",
      };
}
