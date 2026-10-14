import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GILBERT_SOURCE_URL } from "./source.js";

/**
 * Where the source is said to live.
 *
 * One address, two readers: the server falls back to it when `SOURCE_URL` is
 * unset, and the browser falls back to it before a session has arrived. A
 * deployment that patches its own tree sets the variable, so the only way this
 * can be wrong is a second copy in one of the two tiers — which is what this
 * pins: the value is a repository of this project, served over https, and it is
 * the same string whichever module is asked.
 */
describe("GILBERT_SOURCE_URL", () => {
  it("is this project's repository over https", () => {
    const url = new URL(GILBERT_SOURCE_URL);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "github.com");
    assert.equal(url.pathname, "/sequico/gilbert");
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
  });
});
