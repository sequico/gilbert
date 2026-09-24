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
 */

/** The bridge's WebSocket API, on loopback: it is a second process here. */
export const BRIDGE_URL = "ws://127.0.0.1:8188";

/** The subprotocol the Janus API requires on that socket. */
export const JANUS_PROTOCOL = "janus-protocol";
