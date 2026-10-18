import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { personWord, type ReceivedMessage } from "./trust.js";

/**
 * Whether a received message may be read as a person's word (ADR 0033).
 *
 * The decision is one pure answer about one message, and every case below is a
 * way a message must not become an instruction: a `From:` naming somebody the
 * installation knows while the server says the message came from outside and did
 * not authenticate, a sender nobody knows, a verdict nobody can parse, an arrival
 * nobody recorded, and the agent's own words coming back. The other direction is
 * pinned here too, because getting it wrong costs the most ordinary traffic an
 * installation has: mail an account here wrote to a mailbox here never crossed a
 * boundary, so there is no SPF, DKIM or DMARC to verify and the server may write
 * no result at all — it is that account's word on the server's own record of the
 * submission.
 *
 * What a real server writes is a separate question — those shapes are owed a live
 * probe — and what this reading assumes of them is pinned next to the mock
 * (`server/src/mock/message-arrival.test.ts`).
 */

/**
 * The first hop of a message another server handed over: this server's own line,
 * written last and so carried first.
 */
const OUTSIDE =
  "from mail.ada.example (mail.ada.example [203.0.113.7]) by mx.example.org with ESMTPS id 3f2a; Fri, 16 Oct 2026 09:00:00 +0000";

/**
 * The first hop of a message one of this installation's accounts submitted: the
 * server's record of the submission, naming the account it authenticated.
 */
const submitted = (address: string): string =>
  `from [10.0.0.9] (localhost [127.0.0.1]) by mx.example.org with ESMTPSA id 41cb (Authenticated sender: ${address}); Fri, 16 Oct 2026 09:04:00 +0000`;

/** The server's own delivery hop, which names nobody it came from. */
const DELIVERED = "by mx.example.org with LMTP id 9a; Fri, 16 Oct 2026 09:05:00 +0000";

/** A verdict of the shape RFC 8601 gives, and of the shape a live one is owed. */
const VERDICT =
  "mx.example.org; dkim=pass header.d=example.org; spf=pass smtp.mailfrom=ada@example.org";

/** The agent acts as the group's account, whose own address is a known one. */
const ASKING = {
  own: "gilbert@example.com",
  known: [
    "ada@example.org",
    "bob@example.com",
    "team@example.com",
    "gilbert@example.com",
  ],
};

const from = (email: string): ReceivedMessage["from"] => [{ email }];

const message = (over: Partial<ReceivedMessage> = {}): ReceivedMessage => ({
  from: from("ada@example.org"),
  "header:Received:asText:all": [OUTSIDE],
  ...over,
});

describe("personWord", () => {
  it("takes a message an account here submitted to a mailbox here", () => {
    // A local submission: the server accepted it over an authenticated
    // connection, and it wrote no authentication result, because there was
    // nothing for it to verify.
    const decision = personWord(
      message({
        from: from("bob@example.com"),
        "header:Received:asText:all": [submitted("bob@example.com")],
        "header:Authentication-Results:asText": null,
      }),
      ASKING,
    );
    assert.deepEqual(decision, {
      word: true,
      refusal: null,
      from: "bob@example.com",
      run: null,
    });
  });

  it("refuses a message that arrived from outside, whatever verdict it carries", () => {
    // The verdict is worth the authserv-id that wrote it, and what a live
    // Stalwart writes there is the probe the record says it owes. Until it is
    // answered, no verdict makes an outside message a person's word — a sender
    // can write a header as easily as a `From:` line.
    for (const verdict of [
      VERDICT,
      "mx.example.org (Postfix);\r\n dkim=pass (1024-bit key; unprotected) header.d=example.org",
      null,
      "",
    ]) {
      const decision = personWord(
        message({
          "header:Authentication-Results:asText": verdict,
        } as Partial<ReceivedMessage>),
        ASKING,
      );
      assert.equal(decision.word, false, String(verdict));
      assert.equal(decision.refusal, "not_authenticated", String(verdict));
    }
  });

  it("refuses a submission that names no account, or names a different one", () => {
    // A submission is trusted on the server's record of **which account**
    // authenticated: the hop without it leaves only the `From:` line, which is
    // what a sender writes, and a hop naming another account is that account's
    // word and not this sender's.
    for (const hop of [
      "from [10.0.0.9] (localhost [127.0.0.1]) by mx.example.org with ESMTPSA id 41cb",
      submitted("alice@example.com"),
    ]) {
      const decision = personWord(
        message({
          from: from("bob@example.com"),
          "header:Received:asText:all": [hop],
        } as Partial<ReceivedMessage>),
        ASKING,
      );
      assert.equal(decision.word, false, hop);
      assert.equal(decision.refusal, "not_authenticated", hop);
    }
  });

  it("refuses a message whose arrival left no record this reading can use", () => {
    for (const hops of [
      [], // the server recorded nothing
      [DELIVERED], // a delivery hop that names nobody it came from
      [42], // not a hop line at all
    ] as unknown as ReadonlyArray<string>[]) {
      const decision = personWord(
        message({ "header:Received:asText:all": hops }),
        ASKING,
      );
      assert.equal(decision.word, false, JSON.stringify(hops));
      assert.equal(decision.refusal, "not_authenticated", JSON.stringify(hops));
    }
  });

  it("never reads the agent's own words as a person's", () => {
    // Its own send, written as the group's identity: the address is a known
    // principal, so only the mark tells this from a person's reply.
    const echo = personWord(
      {
        ...message({ from: from("team@example.com") }),
        "header:X-Gilbert-Run:asText": "run-7",
      },
      ASKING,
    );
    assert.equal(echo.word, false);
    assert.equal(echo.refusal, "own_send");
    assert.equal(echo.run, "run-7", "a waiting run can tell its own echo");

    // Its own address without the mark: its own mail is still its own.
    const own = personWord(message({ from: from("gilbert@example.com") }), ASKING);
    assert.equal(own.word, false);
    assert.equal(own.refusal, "own_send");
    assert.equal(own.run, null);
  });

  it("refuses a sender the installation does not know, however it arrived", () => {
    for (const over of [
      { from: from("stranger@elsewhere.test") },
      {
        from: from("stranger@elsewhere.test"),
        "header:Received:asText:all": [submitted("stranger@elsewhere.test")],
        "header:Authentication-Results:asText": null,
      },
    ]) {
      const decision = personWord(message(over), ASKING);
      assert.equal(decision.word, false);
      assert.equal(decision.refusal, "unknown_sender");
      assert.equal(decision.from, "stranger@elsewhere.test");
    }
  });
});
