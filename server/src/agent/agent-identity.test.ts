/**
 * Following the agent the deployment names.
 *
 * The agent's address and password are the deployment's, so the identity a fleet
 * serves is compared rather than re-read: `sameIdentity` says whether the two
 * differ, and `identityToFollow` replaces a running fleet only when the new
 * identity can already sign in. These pin the two halves that are easy to get
 * wrong: an unchanged identity costs nothing at all, and a sign-in that fails
 * never stops the fleet that is serving.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type AgentIdentity, identityToFollow, sameIdentity } from "./worker.js";

const running: AgentIdentity = {
  address: "agent@example.com",
  password: "one",
};

/** A deployment naming `wanted`, and a sign-in that answers as it is told. */
function deployment(wanted: AgentIdentity, outcome: "ok" | "refused" = "ok") {
  const asked: AgentIdentity[] = [];
  return {
    asked,
    current: () => wanted,
    signIn: async (identity: AgentIdentity) => {
      asked.push(identity);
      if (outcome === "refused") throw new Error("the mail server said no");
      return {
        authorization: `Basic ${identity.address}`,
        session: {} as never,
      };
    },
  };
}

test("an identity the deployment did not change is left alone", async () => {
  const d = deployment({ ...running });
  assert.equal(sameIdentity(running, d.current()), true);
  assert.equal(await identityToFollow(running, { ...d, log: () => {} }), null);
  assert.deepEqual(d.asked, [], "an unchanged identity signs nobody in again");
});

test("a named agent that signs in becomes the one being served", async () => {
  const wanted: AgentIdentity = {
    address: "other@example.com",
    password: "two",
  };
  const d = deployment(wanted);
  const next = await identityToFollow(running, { ...d, log: () => {} });
  assert.ok(next, "the change is followed");
  assert.deepEqual(next.identity, wanted);
  assert.equal(next.ctx.username, "other@example.com");
  assert.equal(next.ctx.authorization, "Basic other@example.com");
  assert.deepEqual(d.asked, [wanted], "the new identity is the one that signs in");
});

test("a sign-in that fails leaves the fleet that is serving alone", async () => {
  const wanted: AgentIdentity = {
    address: "other@example.com",
    password: "two",
  };
  const d = deployment(wanted, "refused");
  const said: string[] = [];
  assert.equal(
    await identityToFollow(running, { ...d, log: (line) => said.push(line) }),
    null,
  );
  assert.deepEqual(d.asked, [wanted], "the new identity was tried");
  assert.match(said.join("\n"), /keeps serving agent@example\.com/);
});

test("a deployment that names nothing usable is not a reason to stop", async () => {
  const d = deployment({ address: "", password: "" });
  assert.equal(await identityToFollow(running, { ...d, log: () => {} }), null);
  assert.deepEqual(d.asked, [], "nothing signs in for an empty identity");
});
