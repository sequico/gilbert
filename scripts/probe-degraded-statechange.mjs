#!/usr/bin/env node
/**
 * Which type a *degraded* delivery wears.
 *
 * A subscriber names the types it wants and is sent only those. A delivery to an
 * account described by an `emailPush` entry arrives as an `EmailPush` — the
 * payload naming its sender and message. A delivery to an account the
 * subscription serves but does **not** describe is degraded to a plain
 * `StateChange`, and nothing read so far says which name that state change
 * carries.
 *
 * That decides whether group notifications arrive at all. A subscription asking
 * for `EmailDelivery` alone — which is what `web/src/lib/webpush.ts` sends — is
 * sent **nothing** for a degraded delivery if the state change names `Email`. A
 * group's mail would then stop notifying a closed client, silently, rather than
 * merely losing its sender. ADR 0016 keeps this as the fifth item of its debt,
 * under `degraded-statechange-type`.
 *
 * Two ways to ask, and the probe does both:
 *
 *   1. **The event stream, which can be asked from anywhere.** `/eventsource?types=EmailDelivery`
 *      is filtered by the same type names a push subscription uses, so a
 *      delivery that arrives here wearing `EmailDelivery` is one a push
 *      subscription asking for it would also be sent. Nothing has to be
 *      reachable from the server, which is what the second way costs.
 *   2. **A real subscription, which is the direct answer.** It needs a URL the
 *      server can POST to, and Stalwart refuses anything but `https` and refuses
 *      a local or reserved address outright (`validate_push_url`) — so this half
 *      runs only when `GILBERT_PROBE_PUSH_URL` names such a host, and is skipped
 *      otherwise.
 *
 * Either way something has to be delivered while it watches: send a message to
 * an account this credential can see after the probe says it is listening. A
 * group mailbox is the interesting case, since that is the account a
 * subscription serves and does not describe.
 *
 * Usage, against a real instance:
 *
 *   STALWART_URL=https://stalwart.example:8080 \
 *   GILBERT_AGENT_ADDRESS=someone@example.com \
 *   GILBERT_AGENT_PASSWORD='…' \
 *   [GILBERT_PROBE_PUSH_URL=https://probe.example.net/push] \
 *   node scripts/probe-degraded-statechange.mjs [--seconds 90]
 *
 * `--seconds` bounds the wait (default 90). The probe prints `listening` as soon
 * as it is ready, then prints every type name it sees, so a payload received is
 * recorded even when the delivery that carried it was one nobody expected.
 */

import { basic, note, record, report } from "./lib/probeKit.mjs";

const CAP = "urn:ietf:params:jmap:core";
const EMAILPUSH = "urn:ietf:params:jmap:emailpush";
const VAPID = "urn:ietf:params:jmap:webpush-vapid";

const args = process.argv.slice(2);
const numberAfter = (name, fallback) => {
  const i = args.indexOf(name);
  const n = i >= 0 ? Number(args[i + 1]) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const seconds = numberAfter("--seconds", 90);

const STALWART_URL = (process.env.STALWART_URL ?? "").replace(/\/+$/, "");
const ADDRESS = process.env.GILBERT_AGENT_ADDRESS ?? "";
const PASSWORD = process.env.GILBERT_AGENT_PASSWORD ?? "";
const PUSH_URL = process.env.GILBERT_PROBE_PUSH_URL ?? "";
const TIMEOUT = 30_000;

if (!STALWART_URL || !ADDRESS || !PASSWORD) {
  console.error("Set STALWART_URL, GILBERT_AGENT_ADDRESS and GILBERT_AGENT_PASSWORD.");
  process.exit(2);
}

const auth = basic(ADDRESS, PASSWORD);

const session = await fetch(`${STALWART_URL}/.well-known/jmap`, {
  headers: { authorization: auth, accept: "application/json" },
  redirect: "follow",
  signal: AbortSignal.timeout(TIMEOUT),
})
  .then(async (res) => {
    if (!res.ok) throw new Error(`the session endpoint answered ${res.status}`);
    return res.json();
  })
  .catch((err) => {
    // A wrong URL or a wrong credential is the caller's mistake, and a stack
    // trace buries which of the two it was.
    console.error(`Could not read the session from ${STALWART_URL}: ${err.message}`);
    process.exit(2);
  });

/** One JMAP request, against the `apiUrl` the session named. */
async function call(method, args, using = [CAP]) {
  const res = await fetch(session.apiUrl, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ using, methodCalls: [[method, args, "0"]] }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const body = await res.json().catch(() => ({}));
  const [name, answer] = body.methodResponses?.[0] ?? [];
  if (name === "error") {
    throw new Error(`${method}: ${answer?.type ?? "error"} ${answer?.description ?? ""}`);
  }
  return answer;
}

note("emailpush capability", EMAILPUSH in (session.capabilities ?? {}) ? "yes" : "no");
note("webpush-vapid capability", VAPID in (session.capabilities ?? {}) ? "yes" : "no");

/*
 * The event stream, filtered to the one type the browser asks for.
 *
 * A state change arriving here wearing `EmailDelivery` is the same event a push
 * subscription filtered to `EmailDelivery` would be sent; one that does not
 * arrive, while the delivery plainly happened, is the failure this probe exists
 * to find. The stream is opened with `types` and read until the wait is out.
 */
const seen = new Set();

/**
 * The session's event-source URL, with its placeholders filled in.
 *
 * Stalwart advertises this as a template (`…?types={types}&closeafter={closeafter}&ping={ping}`),
 * the same shape `expandTemplate` handles in `server/src/upstream.ts`. A probe
 * that fetched it as it stands would be asking for a type literally named
 * `{types}`, and the server's refusal to read that would look like an answer
 * about the delivery.
 */
function eventSourceUrl(types, closeafter) {
  return String(session.eventSourceUrl)
    .replace("{types}", encodeURIComponent(types))
    .replace("{closeafter}", String(closeafter))
    .replace("{ping}", "30");
}

async function watchStream() {
  const url = eventSourceUrl("EmailDelivery", seconds);
  const res = await fetch(url, {
    headers: { authorization: auth, accept: "text/event-stream" },
    signal: AbortSignal.timeout(seconds * 1000 + 5_000),
  });
  if (!res.ok || !res.body) {
    note("event stream", `could not be opened: HTTP ${res.status}`);
    return;
  }
  console.log(
    `\n  listening on /eventsource?types=EmailDelivery for ${seconds}s — send a message now,\n` +
      "  ideally to a group mailbox this credential can see.\n",
  );
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + seconds * 1000;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Frames are separated by a blank line; `data:` carries the JSON.
      for (const frame of buffer.split("\n\n").slice(0, -1)) {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          try {
            const parsed = JSON.parse(payload);
            if (parsed?.["@type"] === "StateChange")
              for (const account of Object.values(parsed.changed ?? {}))
                for (const type of Object.keys(account ?? {})) seen.add(type);
          } catch {
            /* a ping, or a frame this probe does not read */
          }
        }
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
    }
  } catch {
    /* the wait ended, or the stream closed: both are the answer being read */
  }
}

/*
 * The direct half, when there is a host the server may POST to.
 *
 * Both halves are the point here too: the type is what the browser registers,
 * and the absent `emailPush` is what forces every delivery to arrive degraded,
 * so what reaches the endpoint is the answer with nothing else mixed in.
 */
let id = null;
if (PUSH_URL) {
  try {
    const created = await call(
      "PushSubscription/set",
      {
        create: {
          probe: {
            deviceClientId: `gilbert-probe-${Date.now().toString(36)}`,
            url: PUSH_URL,
            keys: {
              p256dh:
                "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
              auth: "tBHItJI5svbpez7KI4CCXg",
            },
            types: ["EmailDelivery"],
          },
        },
      },
      [CAP, VAPID],
    );
    const refusal = created?.notCreated?.probe;
    if (refusal) {
      record(
        "a subscription naming EmailDelivery alone is accepted",
        `refused: ${refusal.type}`,
        "created",
      );
    } else {
      id = created?.created?.probe?.id ?? null;
      record(
        "a subscription naming EmailDelivery alone is accepted",
        id ? "created" : "no id",
        "created",
      );
      note("subscription id", String(id));
    }
  } catch (err) {
    note("subscription", `could not be registered: ${err.message}`);
  }
} else {
  note("subscription", "not registered: GILBERT_PROBE_PUSH_URL is not set");
}

await watchStream();

if (id) {
  try {
    await call("PushSubscription/set", { destroy: [id] }, [CAP, VAPID]);
    note("subscription", "destroyed");
  } catch (err) {
    note("subscription", `could not be destroyed: ${err.message}`);
  }
}

/*
 * What the stream said.
 *
 * `EmailDelivery` is the answer the code depends on; anything else seen is
 * recorded so the two can be told apart, since a `StateChange` of another type
 * arriving for the same delivery is exactly the failure mode.
 */
for (const type of [...seen].sort()) {
  record(`a delivery to a watched account is announced as`, type, "EmailDelivery");
}
if (!seen.size) {
  /*
   * Nothing at all. That is a question rather than a verdict: it means either
   * the pull is filtered out before it reaches this stream, or no delivery
   * happened during the wait. The caller knows which, and the note says what to
   * do about it.
   */
  note(
    "deliveries seen",
    "none — either nothing was delivered during the wait, or EmailDelivery names no state change at all (which is the answer, and is the failure ADR 0016 warns about)",
  );
}

process.exit(
  report({
    where:
      "ADR 0016, the `degraded-statechange-type` item of its debt, and the note in `web/src/lib/webpush.ts`",
  }),
);
