import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets, redactText, WITHHELD } from "./redact.js";

/**
 * A tool's answer is somebody else's text (ADR 0038): what a credential is named
 * like does not travel into a prompt or the record, and the run says what was
 * withheld.
 */
test("a credential-shaped field is emptied, at any depth, and named", () => {
  const { value, withheld } = redactSecrets({
    path: "Documents/keys.pdf",
    text: "the booking is BK-2",
    meta: [
      { apiKey: "sk-live-123" },
      { nested: { password: "hunter2", label: "portal" } },
    ],
  });

  assert.deepEqual(withheld, ["meta[0].apiKey", "meta[1].nested.password"]);
  assert.deepEqual(value, {
    path: "Documents/keys.pdf",
    text: "the booking is BK-2",
    meta: [{ apiKey: WITHHELD }, { nested: { password: WITHHELD, label: "portal" } }],
  });
});

test("an empty or non-text credential field is left alone", () => {
  const { value, withheld } = redactSecrets({
    password: "",
    token: 42,
    authorization: "   ",
  });
  assert.deepEqual(withheld, []);
  assert.deepEqual(value, { password: "", token: 42, authorization: "   " });
});

test("a credential-named field holding an object is withheld whole", () => {
  /*
   * The field filter walks keys, and a token that holds `{ access, refresh }`
   * hides both behind names no pattern recognises. The container is what the
   * name points at, so the container is what is withheld.
   */
  const { value, withheld } = redactSecrets({
    oauth: { token: { access: "a", refresh: "r" }, expires: 3600 },
  });
  assert.deepEqual(withheld, ["oauth.token"]);
  assert.deepEqual(value, { oauth: { token: WITHHELD, expires: 3600 } });
});

test("a value that is not an object passes through", () => {
  assert.deepEqual(redactSecrets("plain"), { value: "plain", withheld: [] });
  assert.deepEqual(redactSecrets(null), { value: null, withheld: [] });
});

test("a credential pasted into prose is emptied, and the prose around it is kept", () => {
  assert.equal(
    redactText("the portal says password: hunter2, use it once"),
    "the portal says password: [withheld], use it once",
  );
  assert.equal(redactText("api_key=sk-live-1"), "api_key=[withheld]");
  assert.equal(
    redactText("the token bucket is full"),
    "the token bucket is full",
    "a secret word with no assignment is ordinary prose",
  );
});
