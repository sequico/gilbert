import assert from "node:assert/strict";
import { test } from "node:test";
import {
  administrationAllowed,
  gateAdministration,
  mayNameRegistryMethod,
} from "./adminGate.js";

const req = (...methods: string[]) =>
  JSON.stringify({
    using: ["urn:ietf:params:jmap:core"],
    methodCalls: methods.map((m, i) => [m, {}, `c${i}`]),
  });

/**
 * The door ADR 0017 puts in front of the registry (see `adminGate.ts`): with
 * the installation's administration off the menu is not the enforcement, the
 * proxy is. These are the cases that decide what a session which may not
 * administer can still send.
 */

test("mail, calendars and the rest pass untouched", () => {
  const r = gateAdministration(
    req(
      "Email/query",
      "Mailbox/get",
      "CalendarEvent/set",
      "FileNode/get",
      "Principal/getAvailability",
    ),
  );
  assert.equal(r.ok, true);
});

test("the account's own registry objects can be read", () => {
  assert.equal(
    gateAdministration(
      req(
        "x:AccountSettings/get",
        "x:AppPassword/get",
        "x:PublicKey/get",
        "x:MaskedEmail/query",
      ),
    ).ok,
    true,
  );
});

/*
 * `ApiKey` stays on the allowlist through the upstream security pass that
 * removed it, because ADR 0017 names it as readable and the write refusal is
 * what closes the console door. This is the assertion that keeps the record
 * and the code saying the same thing.
 */
test("an API key is still the account's own to read", () => {
  assert.equal(gateAdministration(req("x:ApiKey/get")).ok, true);
});

test("but not written: a credential minted here would outlive a borrowed session", () => {
  for (const m of [
    "x:AppPassword/set",
    "x:AccountPassword/set",
    "x:MaskedEmail/set",
    "x:ApiKey/set",
  ]) {
    assert.deepEqual(gateAdministration(req("x:AccountSettings/get", m)), {
      ok: false,
      method: m,
    });
  }
});

test("directory and server objects are refused, and named", () => {
  for (const m of [
    "x:Account/get",
    "x:Domain/set",
    "x:Role/query",
    "x:Tenant/get",
    "x:SystemSettings/set",
    "x:DkimSignature/get",
    "x:SieveSystemScript/set",
  ]) {
    assert.deepEqual(gateAdministration(req("Email/get", m)), { ok: false, method: m });
  }
});

test("a body that could name a registry method and cannot be read is refused rather than forwarded", () => {
  assert.deepEqual(gateAdministration('{"methodCalls": [["x:Account/get"'), {
    ok: false,
    method: null,
  });
  assert.deepEqual(gateAdministration(JSON.stringify({ methodCalls: "x:Account/get" })), {
    ok: false,
    method: null,
  });
  assert.deepEqual(
    gateAdministration(JSON.stringify({ methodCalls: [[{}, {}, "c"]], note: "x:" })),
    { ok: false, method: null },
  );
});

test("a body that cannot name a registry method is forwarded exactly as it came", () => {
  // Most traffic from a session that may not administer: no parse, no rewrite.
  const raw =
    '{"using":["urn:ietf:params:jmap:core"],"methodCalls":[["Email/get",{"ids":["a"]},"c"]]}';
  assert.equal(mayNameRegistryMethod(raw), false);
  assert.deepEqual(gateAdministration(raw), { ok: true, body: raw });
});

test("a method name hidden behind a unicode escape is still found", () => {
  // JSON.parse and the server both read \u0078 as "x"; a substring check alone would not.
  const raw = '{"methodCalls":[["\\u0078:Account/get",{},"c"]]}';
  assert.equal(mayNameRegistryMethod(raw), true);
  assert.deepEqual(gateAdministration(raw), { ok: false, method: "x:Account/get" });
});

/**
 * The operator's rules, which are the installation's and are separate: whether
 * administration is offered at all, and — only where an installation asks for
 * it — whether it requires a device marked as the person's own. The second is
 * off by default, so a session administers wherever it was opened unless the
 * deployment stated otherwise.
 */
test("administration is offered unless the installation turned it off", () => {
  assert.equal(administrationAllowed(true, false, false), true);
  assert.equal(administrationAllowed(true, false, true), true);
  assert.equal(administrationAllowed(false, false, true), false);
  assert.equal(administrationAllowed(false, false, false), false);
});

test("the own-device rule, where an installation asked for it, needs the device", () => {
  assert.equal(administrationAllowed(true, true, true), true);
  assert.equal(administrationAllowed(true, true, false), false);
});

test("what is forwarded is what was checked", () => {
  // A duplicate key is read one way by JSON.parse; forwarding the parsed form
  // means the server cannot read it the other way.
  const raw =
    '{"methodCalls":[["x:Account/get",{},"a"]],"methodCalls":[["Email/get",{},"b"]]}';
  const r = gateAdministration(raw);
  assert.equal(r.ok, true);
  if (r.ok)
    assert.equal(r.body, JSON.stringify({ methodCalls: [["Email/get", {}, "b"]] }));
});
