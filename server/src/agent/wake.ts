/**
 * Push is the wake-up, polling is the fallback (ADR 0003).
 *
 * The agent's own JMAP EventSource says *which account* and *which type*
 * changed — never what changed. That is all this module extracts: an event is
 * a signal to reconcile, and the executor re-reads the type from the state it
 * recorded. `pollLoop` is what keeps the agent alive when the stream is gone:
 * a lost stream is reported through `onError` and reconnected with a bounded
 * backoff, so a silent agent is never the failure mode.
 */

import { absoluteUpstream, expandTemplate, type UpstreamSession } from "../upstream.js";

/** The first reconnect delay, doubling up to the ceiling below. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
/** The ping interval the stream asks Stalwart for, in seconds. */
const PING_SECONDS = 30;

export interface SseEvent {
  /** The SSE event name; `message` when the frame carried none. */
  event: string;
  data: string;
}

/**
 * Parse what a chunk of an SSE body holds: the frames that are complete, and
 * whatever tail is still waiting for its blank line. Pure, so the framing is
 * testable without a server (a chunk boundary can land anywhere, including in
 * the middle of "event:").
 */
export function parseSseChunk(text: string): { events: SseEvent[]; rest: string } {
  const frames = text.replace(/\r\n/g, "\n").split("\n\n");
  const rest = frames.pop() ?? "";
  const events: SseEvent[] = [];
  for (const frame of frames) {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    // A frame without data is not an event: the spec's ping and comment frames
    // are exactly that, and reporting them would wake the executor for nothing.
    if (data.length) events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
}

/**
 * The account and type of every change a `StateChange` frame names.
 * Null when the frame cannot be read at all, which the caller reports.
 */
function stateChanges(data: string): Array<{ accountId: string; type: string }> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const frame = parsed as { "@type"?: unknown; changed?: unknown };
  if (frame["@type"] !== "StateChange") return [];
  if (!frame.changed || typeof frame.changed !== "object") return [];
  const out: Array<{ accountId: string; type: string }> = [];
  for (const [accountId, byType] of Object.entries(
    frame.changed as Record<string, unknown>,
  )) {
    if (!byType || typeof byType !== "object") continue;
    for (const type of Object.keys(byType as Record<string, unknown>))
      out.push({ accountId, type });
  }
  return out;
}

/**
 * Open the agent's event stream and keep it open.
 *
 * Returns the disposer: it stops the stream, aborts the in-flight request and
 * cancels a pending reconnect. Every failure — refused, dropped, unreadable
 * frame — goes through `onError` before the reconnect, because an agent that
 * silently stopped hearing about changes looks exactly like an agent with
 * nothing to do.
 */
export function openEventStream(
  session: UpstreamSession,
  authorization: string,
  types: ReadonlyArray<string>,
  onEvent: (accountId: string, type: string) => void,
  onError: (err: Error) => void,
): () => void {
  const expanded = expandTemplate(session.eventSourceUrl, {
    types: types.join(","),
    closeafter: "no",
    ping: String(PING_SECONDS),
  });
  // A session whose URL carries no template (or none for the type filter) still
  // has to be asked for the narrow stream: without it Stalwart sends every
  // change of every type the principal can see, including what the worker does
  // not serve.
  const url = absoluteUpstream(
    expanded.includes("types=")
      ? expanded
      : `${expanded}${expanded.includes("?") ? "&" : "?"}types=${encodeURIComponent(
          types.join(","),
        )}&ping=${PING_SECONDS}`,
    session.baseUrl,
  );

  let stopped = false;
  let attempt = 0;
  let controller: AbortController | null = null;
  let reconnect: NodeJS.Timeout | null = null;

  const after = (err: Error) => {
    if (stopped) return;
    onError(err);
    // Exponential, capped, and jittered: a fleet of workers that all lost the
    // same server would otherwise come back in lockstep, at the same millisecond,
    // and knock it over again. The jitter is what turns one herd into a queue.
    const base = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    const delay = Math.max(RECONNECT_BASE_MS / 2, base / 2 + Math.random() * (base / 2));
    attempt += 1;
    reconnect = setTimeout(() => {
      reconnect = null;
      void open();
    }, delay);
  };

  const open = async (): Promise<void> => {
    if (stopped) return;
    controller = new AbortController();
    try {
      const res = await fetch(url, {
        headers: { authorization, accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Stalwart refused the event stream (${res.status})`);
      if (!res.body) throw new Error("the event stream carried no body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let delivered = false;
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseChunk(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.events) {
          if (frame.event !== "state") continue;
          const changes = stateChanges(frame.data);
          if (changes === null) {
            onError(new Error(`the event stream sent a frame this worker cannot read`));
            continue;
          }
          delivered = true;
          for (const change of changes) {
            // A handler that throws must not take the stream down with it: the
            // frame is reported, the next one still arrives, and the worker
            // keeps hearing about changes — a lost stream is how a worker goes
            // quiet without anybody noticing.
            try {
              onEvent(change.accountId, change.type);
            } catch (err) {
              onError(err instanceof Error ? err : new Error(String(err)));
            }
          }
        }
      }
      if (!stopped) {
        // A stream that delivered frames was working, and the next loss starts
        // its backoff from the beginning; one that ended before any frame did
        // not, and keeps backing off — the other way round, a server that
        // accepts and closes immediately would be reconnected to once a second,
        // forever, by every worker at once.
        if (delivered) attempt = 0;
        after(new Error("the event stream ended"));
      }
    } catch (err) {
      if (stopped) return;
      after(err instanceof Error ? err : new Error(String(err)));
    }
  };

  void open();
  return () => {
    stopped = true;
    if (reconnect) clearTimeout(reconnect);
    reconnect = null;
    controller?.abort();
    controller = null;
  };
}

/** When the poll loop last ran its tick, per `opts.now`. */
export interface PollLoopOpts {
  /**
   * The clock the loop measures its interval with. Injected so a test can run
   * the loop against a clock it controls; the timer itself is always real.
   */
  now?: () => number;
  /**
   * What to do with what the tick threw. The loop survives a failed tick and
   * says nothing about it by itself: the caller is the one that knows what it
   * was running, and a caller that passes nothing is one whose failures are
   * invisible.
   */
  onError?: (err: unknown) => void;
}

/**
 * Run `tick` every `intervalMs`, as the fallback after a lost stream.
 *
 * The tick's own failures are its business: it is a pass over state that
 * recomputes, so a throw is logged by the caller's tick and the loop carries on
 * rather than stopping the agent. A tick that takes longer than the interval
 * never stacks another one.
 */
export function pollLoop(
  intervalMs: number,
  tick: () => Promise<void>,
  opts: PollLoopOpts = {},
): () => void {
  const now = opts.now ?? Date.now;
  let stopped = false;
  let running = false;
  let last = now();
  let timer: NodeJS.Timeout | null = null;

  const schedule = () => {
    if (stopped) return;
    const delay = Math.max(0, intervalMs - (now() - last));
    timer = setTimeout(() => void run(), delay);
  };

  const run = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    last = now();
    try {
      await tick();
    } catch (err) {
      // The loop does not die with one tick, and it does not keep the failure to
      // itself either: the caller names it, and moves on.
      opts.onError?.(err);
    }
    running = false;
    schedule();
  };

  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
