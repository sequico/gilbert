#!/usr/bin/env node
/**
 * The live probe of an account's push subscriptions — and the way to give the
 * slots back.
 *
 * An account holds fifteen `PushSubscription`s. Gilbert registers one per
 * account for its own fan-out, and a deployment that was killed rather than
 * shut down left its own behind: the process that knew the subscription's id
 * died with it, and the only credential that can destroy one was that
 * process's session. Thirteen such URLs, all under this installation's own
 * callback, were still being POSTed to and answered 404 before this was
 * written (KNOWN-ISSUES). Once the fifteen are gone, every further create is
 * refused with `overquota`, and the account quietly stays on the per-tab relay.
 *
 * The questions, asked the way the code asks them:
 *
 *   1. how many subscriptions does the account hold, and of what ceiling?
 *   2. which of them are this installation's — recognised by their URL, which
 *      is the only mark a dead process leaves (its `deviceClientId` was
 *      random, and the code that keeps a stable one cannot match it either)?
 *   3. (with `GILBERT_PROBE_ACCOUNT`) does an admin credential reach the
 *      account through impersonation, so somebody else's slots can be read?
 *   4. (with `--destroy-ours`) do they go, and (with `--create-check`) does a
 *      create work afterwards? That create is the only proof the account left
 *      `overquota`.
 *
 * Nothing is destroyed unless `--destroy-ours` is given, and even then only
 * subscriptions whose URL is under the callback base you name — which includes
 * the subscription a *running* deployment is serving from, if its callback is
 * under that base. Restart the deployment afterwards, or it will sit on the
 * per-tab relay until its next renewal.
 *
 * Usage, against a real instance:
 *
 *   STALWART_URL=https://stalwart.example:8080 \
 *   GILBERT_AGENT_ADDRESS=admin@example.com \
 *   GILBERT_AGENT_PASSWORD='…' \
 *   [GILBERT_PROBE_ACCOUNT=someone@example.com] \
 *   node scripts/probe-push-subscriptions.mjs \
 *     [--ours https://ops.example.eu/webmail] [--destroy-ours]
 *
 * `--ours` is the origin plus base path this installation's push callback
 * lives under — `origin + basePath + "/api/push/"` is what a subscription of
 * ours looks like. Without it the probe still counts and lists, and `--destroy-ours`
 * does nothing rather than guessing.
 */
const CAP = "urn:ietf:params:jmap:core";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const STALWART_URL = (process.env.STALWART_URL ?? "").replace(/\/+$/, "");
const ADDRESS = process.env.GILBERT_AGENT_ADDRESS ?? "";
const PASSWORD = process.env.GILBERT_AGENT_PASSWORD ?? "";
const ACCOUNT = process.env.GILBERT_PROBE_ACCOUNT ?? "";
const OURS = (value("--ours") ?? "").replace(/\/+$/, "");
const DESTROY = flag("--destroy-ours");
const CREATE_CHECK = flag("--create-check");
const SHOW_URLS = flag("--show-urls");

if (!STALWART_URL || !ADDRESS || !PASSWORD) {
  console.error(
    "STALWART_URL, GILBERT_AGENT_ADDRESS and GILBERT_AGENT_PASSWORD are required",
  );
  process.exit(2);
}

/** Stalwart's composite credential: the target, authenticated by the admin. */
const authorizationFor = (target) => {
  const user = target ? `${target}%${ADDRESS}` : ADDRESS;
  return `Basic ${Buffer.from(`${user}:${PASSWORD}`).toString("base64")}`;
};

async function call(session, authorization, method, args, using = [CAP]) {
  const res = await fetch(session.apiUrl, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ using: [CAP, ...using], methodCalls: [[method, args, "0"]] }),
  });
  if (!res.ok) throw new Error(`${method}: upstream ${res.status}`);
  const body = await res.json();
  const [name, payload] = body.methodResponses[0];
  if (name === "error")
    throw new Error(`${method}: ${payload.description ?? payload.type}`);
  return payload;
}

const authorization = authorizationFor(ACCOUNT);

/** An HTTP answer, or the status and the body that explain why there is none. */
async function json(url, headers) {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  if (!res.ok)
    throw new Error(`${url}: HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${url}: answer was not JSON: ${body.slice(0, 200)}`);
  }
}

const session = await json(`${STALWART_URL}/.well-known/jmap`, {
  authorization,
  accept: "application/json",
}).catch((err) => {
  console.error(`the probe could not finish: ${err.message}`);
  process.exit(1);
});

const accountId =
  session.primaryAccounts?.["urn:ietf:params:jmap:mail"] ??
  Object.keys(session.accounts ?? {})[0];
console.log(`account:  ${ACCOUNT || ADDRESS} (${accountId})`);
console.log(`session:  ${session.apiUrl}`);

const list = (await call(session, authorization, "PushSubscription/get", { ids: null }))
  .list;
console.log(`held:     ${list.length} of Stalwart's 15`);

const ours = list.filter(
  (s) => OURS && String(s.url ?? "").startsWith(`${OURS}/api/push/`),
);
/** The callback URL's token is the only thing authenticating it: shown, not printed. */
const redact = (url) =>
  SHOW_URLS
    ? String(url ?? "")
    : String(url ?? "").replace(/\/api\/push\/[^/?#]+/, "/api/push/<token>");

for (const s of list) {
  const mark = ours.includes(s) ? "ours" : "    ";
  console.log(
    `  ${mark}  ${s.id}  ${s.deviceClientId ?? "(no device id)"}\n` +
      `        url: ${redact(s.url)}\n        expires: ${s.expires ?? "never"}`,
  );
}
if (!OURS)
  console.log(
    "\n(no --ours given: nothing is marked as this installation's, and nothing can be destroyed)",
  );

if (DESTROY) {
  if (!ours.length) {
    console.log(
      `\n0 of ${list.length} under ${OURS || "(no --ours given)"}: nothing to destroy`,
    );
    process.exit(1);
  }
  const ids = ours.map((s) => s.id);
  const answer = await call(session, authorization, "PushSubscription/set", {
    destroy: ids,
  });
  const gone = answer.destroyed ?? [];
  const refused = answer.notDestroyed ?? {};
  console.log(`\ndestroyed ${gone.length} of ${ids.length} subscription(s)`);
  for (const [id, why] of Object.entries(refused))
    console.log(`  refused: ${id}: ${why.type ?? "no reason given"}`);
  /* These are the slots a running deployment was serving from as well, if its
     callback is under the base: it does not know they are gone and will keep
     reporting itself verified until its own expiry. */
  console.log(
    "a running deployment under this callback now has no subscription: restart it",
  );
  const after = (
    await call(session, authorization, "PushSubscription/get", { ids: null })
  ).list;
  console.log(`held now: ${after.length} of 15`);
  if (!gone.length) process.exit(1);
}

if (CREATE_CHECK) {
  /* The only evidence that the account left `overquota`: a create, and then the
     row it made taken back out of the way. */
  const made = await call(session, authorization, "PushSubscription/set", {
    create: {
      s: {
        deviceClientId: `gilbert-probe-${Date.now()}`,
        url: `${OURS || STALWART_URL}${OURS ? "/api/push/" : ""}probe-not-a-real-callback`,
        types: ["Email"],
      },
    },
  });
  const id = made.created?.s?.id;
  const why = made.notCreated?.s ?? {};
  if (id) {
    console.log(`\ncreate check: accepted (id ${id}) — taking it back`);
    await call(session, authorization, "PushSubscription/set", { destroy: [id] });
  } else {
    console.log(`\ncreate check: refused — ${why.type}: ${why.description ?? ""}`);
    process.exit(1);
  }
}
