#!/usr/bin/env node
/**
 * The live probe of conditional writes (ADR 0003 resolution 19).
 *
 * Everything the fleet's coordination rests on assumes Stalwart honours
 * `ifInState` on `FileNode/set`: that the mismatch arrives as `stateMismatch`,
 * that it is not masked as `invalidArguments`, that the FileNode state token
 * advances on the writes that matter, and whether a blob upload — which writes
 * no node — advances it at all. The mock simulates every one of those
 * (`server/src/mock/index.ts`, `checkIfInState`, whose TODO this script
 * answers); until a real instance is asked, the agent tests prove the client's
 * logic against a simulation and not the server's behaviour.
 *
 * Five questions, asked the way the code asks them:
 *
 *   1. is a conditional `FileNode/set` refused at all when the token is stale?
 *   2. does the refusal arrive as `stateMismatch` (RFC 8620 §5.3), the type the
 *      client raises its own error from — or as `invalidArguments`?
 *   3. does the state token advance on a write that succeeded, so that a second
 *      conditional write with the old token is refused?
 *   4. does a blob **upload** advance it, though it writes no node?
 *   5. does the order the code itself uses survive the answer? `writeAppFileAt`
 *      reads the state, then uploads a blob, then sets conditionally
 *      (`server/src/appFolder.ts`). If an upload moves the token, that
 *      conditional set fails every single time — the audit would queue on every
 *      pass and never land. Question 5 is the composed case: read, upload, then
 *      set with the token read before the upload.
 *
 * Credentials come from the environment and are never written anywhere. The
 * probe creates one folder, asserts about it, and destroys it; nothing else is
 * touched, and a run that cannot clean up says so rather than pretending.
 *
 *   GILBERT_PROBE_URL=https://stalwart.example:8080 \
 *   GILBERT_PROBE_USER=admin@example.com \
 *   GILBERT_PROBE_PASS='…' \
 *   node scripts/probe-conditional-writes.mjs
 */

import { basic, record, report, requireProbeEnvironment } from "./lib/probeKit.mjs";

const base = (process.env.GILBERT_PROBE_URL ?? "").replace(/\/+$/, "");
const user = process.env.GILBERT_PROBE_USER ?? "";
const password = process.env.GILBERT_PROBE_PASS ?? "";

requireProbeEnvironment(
  [base, user, password],
  [
    "This probe asks a real server, so it needs credentials in the environment:",
    "  GILBERT_PROBE_URL   the instance, e.g. https://stalwart.example:8080",
    "  GILBERT_PROBE_USER  an administrator account",
    "  GILBERT_PROBE_PASS  its password",
    "",
    "Nothing is written to the repository, and the only thing it creates is a",
    "folder it destroys again in the same run.",
  ],
);

const CORE_CAP = "urn:ietf:params:jmap:core";
/* Stalwart's own FileNode capability, the one the app authenticates against. */
const FILENODE_CAP = "urn:ietf:params:jmap:filenode";
const sessionUrl = process.env.GILBERT_PROBE_SESSION_URL || `${base}/.well-known/jmap`;
const auth = basic(user, password);
const jsonHeaders = { authorization: auth, "content-type": "application/json" };

async function session() {
  const res = await fetch(sessionUrl, { headers: { authorization: auth } });
  if (!res.ok) throw new Error(`the session could not be read: HTTP ${res.status}`);
  return await res.json();
}

async function jmap(methodCalls, apiUrl) {
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ using: [CORE_CAP, FILENODE_CAP], methodCalls }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text).methodResponses ?? [];
}

/** The account whose capabilities carry the FileNode one — the app's own rule. */
function pickAccount(session) {
  for (const [id, account] of Object.entries(session.accounts ?? {})) {
    if (account?.accountCapabilities?.[FILENODE_CAP]) return id;
  }
  const primary = session.primaryAccounts?.[FILENODE_CAP];
  if (primary) return primary;
  const first = Object.keys(session.accounts ?? {})[0];
  if (!first) throw new Error("the session lists no account that could hold Files");
  return first;
}

const run = async () => {
  const opened = await session();
  const accountId = pickAccount(opened);
  // The API endpoint is the session’s own, exactly as the client takes it: a
  // deployment may serve JMAP under a path of its own, and a probe that assumed
  // `/jmap` would be asking a different server than the code asks.
  const apiUrl = String(opened.apiUrl ?? `${base}/jmap`);
  console.log(`Asking ${base} (account ${accountId}) — ${new Date().toISOString()}`);

  /** The account's FileNode state, read the way `appFolderState` reads it. */
  const stateNow = async () => {
    const [found] = await jmap([["FileNode/get", { accountId, ids: [] }, "g"]], apiUrl);
    const state = found?.[1]?.state;
    if (typeof state !== "string")
      throw new Error("no state came back from FileNode/get");
    return state;
  };

  const createFolder = async (name, ifInState) => {
    const [set] = await jmap(
      [
        [
          "FileNode/set",
          {
            accountId,
            ...(ifInState === undefined ? {} : { ifInState }),
            create: { d: { parentId: null, name, nodeType: "directory" } },
          },
          "s",
        ],
      ],
      apiUrl,
    );
    return set?.[1] ?? {};
  };

  const uploadBlob = async () => {
    const template = String(opened.uploadUrl ?? "");
    if (!template) throw new Error("the session carries no uploadUrl");
    const url = template.replace("{accountId}", encodeURIComponent(accountId));
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: auth, "content-type": "text/plain" },
      body: "gilbert probe",
    });
    if (!res.ok) throw new Error(`the upload was refused: HTTP ${res.status}`);
    return await res.json();
  };

  const stamp = Date.now();
  const stale = `stale-${stamp}`;
  const made = [];

  // 1 and 2: a stale token is refused, and refused as `stateMismatch`.
  const before = await stateNow();
  const refused = await createFolder(`gilbert-probe-refused-${stamp}`, stale);
  const refusedType = String(refused.type ?? (refused.created ? "no-error" : "unknown"));
  record(
    "1. a stale ifInState is refused",
    refusedType === "no-error" ? "applied anyway" : "refused",
    "refused",
  );
  record("2. the refusal's type", refusedType, "stateMismatch");

  // 3: a write that succeeded moves the token.
  const created = await createFolder(`gilbert-probe-${stamp}`, before);
  if (created.created?.d?.id) made.push(String(created.created.d.id));
  const afterCreate = await stateNow();
  record(
    "3. the token advances on a write that succeeded",
    afterCreate !== before ? "advances" : "unchanged",
    "advances",
  );
  // …and the token it moved away from is now refused, which is the property the
  // compare-and-set actually needs.
  const second = await createFolder(`gilbert-probe-second-${stamp}`, before);
  if (second.created?.d?.id) made.push(String(second.created.d.id));
  record(
    "3b. the token read before the write is refused after it",
    String(second.type ?? (second.created ? "no-error" : "unknown")),
    "stateMismatch",
  );

  // 4: whether a blob upload — no node written — moves it.
  const beforeUpload = await stateNow();
  const blob = await uploadBlob();
  if (!blob?.blobId) throw new Error("the upload answered without a blobId");
  const afterUpload = await stateNow();
  record(
    "4. a blob upload advances the token",
    afterUpload !== beforeUpload ? "advances" : "unchanged",
    "unchanged",
  );

  // 5: the composed case the code itself runs — read, upload, set conditionally
  // with the token read before the upload.
  const beforeComposed = await stateNow();
  await uploadBlob();
  const composed = await createFolder(`gilbert-probe-composed-${stamp}`, beforeComposed);
  if (composed.created?.d?.id) made.push(String(composed.created.d.id));
  record(
    "5. the code's order (read, upload, set) survives",
    composed.type === "stateMismatch" ? "refused" : "accepted",
    "accepted",
  );

  // Clean up whatever was created, and say so if that failed.
  if (made.length) {
    const [destroyed] = await jmap(
      [["FileNode/set", { accountId, destroy: made }, "x"]],
      apiUrl,
    );
    const failed = Array.isArray(destroyed?.notDestroyed)
      ? destroyed.notDestroyed.length
      : 0;
    console.log(
      failed
        ? `Could not remove ${failed} probe folder(s): remove them by hand (names start with "gilbert-probe").`
        : `Removed ${made.length} probe folder(s).`,
    );
  }

  return report({
    where: "in ADR 0003 resolution 19 and in the mock's note beside `checkIfInState`",
  });
};

run()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(
      `the probe could not finish: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
