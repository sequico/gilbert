/**
 * The phone's bridge, as gilbertserver reaches it (ADR 0023).
 *
 * The bridge is Janus with its SIP plugin, a second process of this same
 * release: beside the server inside the one image, or beside it on the host
 * when the installer is used. Either way it is on loopback, and its API is
 * never exposed — only gilbertserver proxies the browser's WebSocket to it.
 * Its media range, its STUN responder's port and the ports an operator opens
 * are the deployment's; the administration states them, `BRIDGE_MEDIA_PORTS`
 * and `BRIDGE_STUN_PORT` in `@gilbert/shared/phone`.
 *
 * The bridge is **optional**: a host that cannot build Janus installs Gilbert
 * without the phone, and `bridgeReachable` is how the administration knows to
 * say so.
 */
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
import { BRIDGE_MEDIA_PORTS, BRIDGE_STUN_PORT } from "../shared/phone.js";

/** The bridge's WebSocket API, on loopback: it is a second process here. */
export const BRIDGE_URL = "ws://127.0.0.1:8188";

/** The subprotocol the Janus API requires on that socket. */
export const JANUS_PROTOCOL = "janus-protocol";

/**
 * Where the bridge's own version is written beside it, by the image and by the
 * release tarball. Read best-effort: a bridge that is not installed has none,
 * which is an answer, not a fault.
 */
const VERSION_FILE = "/usr/local/share/janus/VERSION";

/** How long the bridge is given to answer the status probe. */
const PROBE_TIMEOUT_MS = 1500;

/** What the administration reads about the bridge. */
export interface BridgeStatus {
  /** Whether the daemon answers on loopback. */
  available: boolean;
  /** Why it does not, in a sentence, when it does not. */
  reason: string | null;
  /** The Janus the deployment installed, or null when there is none. */
  version: string | null;
  /** The media range the deployment opens, `BRIDGE_MEDIA_PORTS`. */
  mediaPorts: string;
  /** The STUN responder's port, `BRIDGE_STUN_PORT`. */
  stunPort: number;
}

function installedVersion(): string | null {
  try {
    const value = readFileSync(VERSION_FILE, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Probe the bridge on loopback, and report what the deployment installed.
 *
 * A probe, not a setting: it says whether the daemon answers, which is what
 * lets the administration tell an operator the phone is unavailable and why.
 * Whether the **media** can flow is a separate fact, proven by the client
 * against the bridge before it offers the phone.
 */
export async function bridgeReachable(): Promise<BridgeStatus> {
  const version = installedVersion();
  const mediaPorts = BRIDGE_MEDIA_PORTS;
  const stunPort = BRIDGE_STUN_PORT;
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
    ? { available: true, reason: null, version, mediaPorts, stunPort }
    : {
        available: false,
        reason: "the phone's bridge is not running on this host",
        version,
        mediaPorts,
        stunPort,
      };
}
