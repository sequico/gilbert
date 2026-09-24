/**
 * The phone's signalling socket (ADR 0023).
 *
 * The browser speaks the **Janus API** — JSON over a WebSocket — and this is
 * what puts that socket on gilbertserver's own origin and certificate: the
 * route is behind the Gilbert session, and every frame is piped to the
 * deployment's bridge. The page therefore reaches no second endpoint and holds
 * no bridge address, and a deployment with no bridge answers nothing here.
 *
 * The connection is opened lazily, on the first frame, so an idle tab holds no
 * upstream socket, and it is torn down with either end.
 */
import { upgradeWebSocket } from "@hono/node-server";
import type { WSContext } from "hono/ws";
import { WebSocket } from "ws";
import { BRIDGE_URL, JANUS_PROTOCOL } from "./bridge.js";

/** The readyState of an open socket, from `ws` and from the browser alike. */
const OPEN = WebSocket.OPEN;

/** One upstream connection, opened on demand and pump both ways. */
export const phoneSocket = upgradeWebSocket(() => {
  let upstream: WebSocket | null = null;
  /** Frames the page sent before the upstream socket was ready. */
  const pending: string[] = [];

  const send = (frame: string) => {
    if (upstream && upstream.readyState === OPEN) upstream.send(frame);
    else pending.push(frame);
  };

  const open = (ws: WSContext) => {
    if (upstream) return;
    const socket = new WebSocket(BRIDGE_URL, JANUS_PROTOCOL);
    upstream = socket;
    socket.on("open", () => {
      for (const frame of pending.splice(0)) socket.send(frame);
    });
    socket.on("message", (data) => {
      ws.send(data.toString());
    });
    const end = () => {
      upstream = null;
      ws.close();
    };
    socket.on("close", end);
    socket.on("error", end);
  };

  return {
    onOpen(_event, ws) {
      open(ws);
    },
    onMessage(event, ws) {
      open(ws);
      const frame = typeof event.data === "string" ? event.data : "";
      if (frame) send(frame);
    },
    onClose() {
      upstream?.close();
      upstream = null;
      pending.length = 0;
    },
    onError() {
      upstream?.close();
      upstream = null;
      pending.length = 0;
    },
  };
});
