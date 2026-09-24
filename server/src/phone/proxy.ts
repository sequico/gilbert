/**
 * The phone's signalling socket (ADR 0023).
 *
 * The browser speaks the **Janus API** — JSON over a WebSocket — and this is
 * what puts that socket on gilbertserver's own origin and certificate: the
 * route is behind the Gilbert session, and every frame is piped to the
 * deployment's bridge. The page therefore reaches no second endpoint and holds
 * no bridge address, and a deployment with no bridge answers nothing here.
 *
 * The upstream is opened as soon as an authenticated browser connects, so a
 * bridge that is down fails at once rather than at the first frame, and it is
 * torn down with either end. Frames that arrive before the upstream is open are
 * buffered, and the buffer is dropped with the connection.
 */
import { upgradeWebSocket } from "@hono/node-server";
import type { WSContext } from "hono/ws";
import { WebSocket } from "ws";
import { BRIDGE_URL, JANUS_PROTOCOL } from "./bridge.js";

/** The readyState of an open socket, from `ws` and from the browser alike. */
const OPEN = WebSocket.OPEN;

/** How long the bridge is given to answer before the client is given up on. */
const CONNECT_TIMEOUT_MS = 5000;

/** One upstream connection, opened with the client and piped both ways. */
export const phoneSocket = upgradeWebSocket(() => {
  let upstream: WebSocket | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Frames the page sent before the upstream socket was ready. */
  const pending: string[] = [];

  const clearTimer = () => {
    if (connectTimer === null) return;
    clearTimeout(connectTimer);
    connectTimer = null;
  };

  const end = (client: WSContext) => {
    clearTimer();
    upstream = null;
    pending.length = 0;
    client.close();
  };

  const open = (client: WSContext) => {
    // CONNECTING or OPEN: the one already on its way is the one to use. A
    // CLOSING/CLOSED socket is replaced rather than buffered into.
    if (upstream && upstream.readyState < WebSocket.CLOSING) return;
    const socket = new WebSocket(BRIDGE_URL, JANUS_PROTOCOL);
    upstream = socket;
    connectTimer = setTimeout(() => socket.terminate(), CONNECT_TIMEOUT_MS);
    socket.on("open", () => {
      clearTimer();
      for (const frame of pending.splice(0)) socket.send(frame);
    });
    socket.on("message", (data) => {
      client.send(data.toString());
    });
    socket.on("close", () => end(client));
    socket.on("error", () => end(client));
  };

  return {
    onOpen(_event, ws) {
      open(ws);
    },
    onMessage(event, ws) {
      open(ws);
      const frame = typeof event.data === "string" ? event.data : "";
      if (!frame) return;
      if (upstream && upstream.readyState === OPEN) upstream.send(frame);
      else pending.push(frame);
    },
    onClose() {
      clearTimer();
      upstream?.close();
      upstream = null;
      pending.length = 0;
    },
    onError() {
      clearTimer();
      upstream?.close();
      upstream = null;
      pending.length = 0;
    },
  };
});
