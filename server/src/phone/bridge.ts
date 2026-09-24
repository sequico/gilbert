/**
 * The phone's bridge, as gilbertserver reaches it (ADR 0023).
 *
 * The bridge is the deployment's own Janus with its SIP plugin, a sibling
 * process. Its address is a fact of the deployment rather than a setting an
 * operator states: the canonical service name on the deployment's own network,
 * so gilbertserver reaches it with nothing to configure and nothing to
 * duplicate. Where it lives and which ports it needs are the deployment's —
 * the one thing the administration states is the media range it must open.
 */

/** The bridge's WebSocket API, by the canonical name of the service that runs it. */
export const BRIDGE_URL = "ws://janus:8188";

/** The subprotocol the Janus API requires on that socket. */
export const JANUS_PROTOCOL = "janus-protocol";
