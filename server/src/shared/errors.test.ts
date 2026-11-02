import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { errorMessage, isNetworkFailure, UNREACHABLE } from "./errors.js";

/**
 * A request that never arrived is a sentence, not the browser's words.
 *
 * Every surface that shows a caught failure hands it to `errorMessage`, so the
 * place a dropped connection is named is one. Before this the pane printed
 * Chrome's "Failed to fetch" — a string that says nothing about the server, is
 * not translated, and reads the same for a genuine outage and a socket closed
 * under an idle page.
 */

describe("the message of a thrown value", () => {
  it("names a request that never arrived, whichever browser said it", () => {
    for (const words of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Load failed",
      "fetch failed",
    ]) {
      const err = new TypeError(words);
      assert.equal(isNetworkFailure(err), true);
      assert.equal(errorMessage(err), UNREACHABLE);
    }
  });

  it("keeps a server's own sentence, and a TypeError that is not the transport", () => {
    assert.equal(errorMessage(new Error("Mailbox not found")), "Mailbox not found");
    assert.equal(
      errorMessage(new TypeError("x is not a function")),
      "x is not a function",
    );
  });
});
