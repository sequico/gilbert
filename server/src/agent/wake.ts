/**
 * The agent's wake: one event stream from this server to Stalwart.
 *
 * The pass is asked for when something changes, and the ten-second interval is
 * only the floor. A browser subscription is not enough — the agent works with
 * every tab closed, and the origin Stalwart must POST a PushSubscription back
 * to is learned from a request — so the server holds its own stream instead:
 * one upstream connection with the Master's credential, open for the life of
 * the process, carrying the same StateChange the tabs would receive. No client
 * has to be open, and nothing has to be configured but the mail server itself.
 *
 * A stream that ends — a deploy, a network drop, Stalwart's own cap — is
 * re-opened with a growing pause; until it is, the interval keeps working. The
 * failure is never fatal: the agent is the interval plus an accelerator.
 */

import { config } from "../config.js";
import { WAKE_STATE_TYPES } from "../shared/push.js";
import { absoluteUpstream, expandTemplate } from "../upstream.js";

/** What the stream needs: where Stalwart's events are, and who is asking. */
export interface WakeSource {
  eventSourceUrl: string;
  baseUrl: string;
  authorization: string;
}

/**
 * Open the wake stream and answer the way to close it.
 *
 * `onWake` is called for a state frame and nothing else; a ping, a comment or
 * a frame of another kind is not a reason to ask for a pass.
 */
export function startAgentWake(
  source: WakeSource,
  onWake: () => void,
  opts: { retryMs?: number; pingSeconds?: number } = {},
): () => void {
  if (!source.eventSourceUrl) return () => {};
  const url = absoluteUpstream(
    expandTemplate(source.eventSourceUrl, {
      types: WAKE_STATE_TYPES.join(","),
      closeafter: "no",
      ping: String(opts.pingSeconds ?? 30),
    }),
    source.baseUrl || config.stalwartUrl,
  );
  const retryMs = opts.retryMs ?? 1_000;
  /**
   * A frame that never ends is not a frame: the buffer stops at a megabyte and
   * the stream is re-opened rather than growing with whatever the peer sends.
   */
  const bufferMax = 1 << 20;
  const maxRetryMs = 30_000;
  let stopped = false;
  let controller: AbortController | null = null;
  let timer: NodeJS.Timeout | null = null;
  let wait = retryMs;

  const read = async (): Promise<void> => {
    const own = new AbortController();
    controller = own;
    try {
      const res = await fetch(url, {
        headers: {
          authorization: source.authorization,
          accept: "text/event-stream",
        },
        signal: own.signal,
      });
      if (!res.ok || !res.body) throw new Error(`the wake stream answered ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        let text = decoder.decode(value, { stream: true });
        if (!text) continue;
        // A CR held from the previous chunk may be the first half of a CRLF.
        if (buffer.endsWith("\r")) {
          buffer = buffer.slice(0, -1);
          text = `\r${text}`;
        }
        // Hold a trailing CR too: the next chunk may begin with its LF.
        let held = "";
        if (text.endsWith("\r")) {
          held = "\r";
          text = text.slice(0, -1);
        }
        buffer += text;
        // Only a chunk that carries a CR pays for normalisation; the usual LF
        // frame is appended as it came, so a large frame stays linear.
        if (text.includes("\r")) buffer = buffer.replace(/\r\n?/g, "\n");
        /*
         * Complete frames are drained first: the cap is for a frame that never
         * ends, not for a burst that happens to arrive in one chunk. A frame
         * that did arrive is also the connection proving it works, so the next
         * break starts its backoff from the floor.
         */
        for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          wait = retryMs;
          // A frame's event name is its own line; data and comments are not.
          if (/(^|\n)event:[ \t]*state[ \t]*(\n|$)/.test(frame)) {
            try {
              onWake();
            } catch {
              // A listener cannot stop the stream it was told about.
            }
          }
        }
        buffer += held;
        if (buffer.length > bufferMax)
          throw new Error("the wake stream sent a frame with no end");
      }
    } catch (err) {
      // A parser error or the cap is not the server closing: the body may still
      // be open, so it is aborted before the reconnect replaces the controller.
      own.abort();
      throw err;
    }
  };

  const run = async (): Promise<void> => {
    if (stopped) return;
    try {
      await read();
    } catch {
      // A refused, dropped or aborted stream: the interval covers the gap.
    }
    if (stopped) return;
    timer = setTimeout(() => void run(), wait);
    wait = Math.min(wait * 2, maxRetryMs);
    timer.unref();
  };

  void run();
  return () => {
    stopped = true;
    controller?.abort();
    if (timer) clearTimeout(timer);
  };
}
