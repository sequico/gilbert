import { afterEach, describe, expect, it } from "vitest";
import {
  formatAddress,
  initials,
  isValidEmail,
  parseAddressList,
  parseMailto,
  summarizeAddresses,
} from "../address";
import { setCatalog } from "../i18n";

describe("address parsing", () => {
  it("parses mixed lists", () => {
    const list = parseAddressList(
      'Ann Example <ann@example.com>, bob@example.org; "Smith, John" <j@x.io>',
    );
    expect(list).toEqual([
      { name: "Ann Example", email: "ann@example.com" },
      { name: null, email: "bob@example.org" },
      { name: "Smith, John", email: "j@x.io" },
    ]);
  });
  it("formats with quoting when needed", () => {
    expect(formatAddress({ name: "Smith, John", email: "j@x.io" })).toBe(
      '"Smith, John" <j@x.io>',
    );
    expect(formatAddress({ name: null, email: "j@x.io" })).toBe("j@x.io");
  });
  it("validates and initials", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("nope")).toBe(false);
    /*
     * The client and the server name an address with one predicate, so an
     * address one of them accepts the other accepts too. An apostrophe is legal
     * in the local part: the client used to exclude it, and a person with one
     * could not write to anybody — the composer refused the send.
     */
    expect(isValidEmail("o'brien@example.com")).toBe(true);
    expect(isValidEmail("first last@example.com")).toBe(false);
    expect(initials({ name: "Grace Hopper", email: "" })).toBe("GH");
    expect(initials({ name: null, email: "linus@kernel.org" })).toBe("LK");
  });

  it("honours a backslash-escaped quote inside a quoted display name", () => {
    expect(parseAddressList('"C, D \\"the third\\"" <c@z.io>')).toEqual([
      { name: 'C, D "the third"', email: "c@z.io" },
    ]);
  });

  it("strips a comment and a group label, which are not part of the address", () => {
    expect(parseAddressList("Friends: (the team) ann@x.com, bob@y.com;")).toEqual([
      { name: null, email: "ann@x.com" },
      { name: null, email: "bob@y.com" },
    ]);
  });

  it("drops a segment that is not a real address", () => {
    expect(parseAddressList("not an address")).toEqual([]);
    expect(parseAddressList("Ann <not-an-address>")).toEqual([]);
  });

  it("strips control characters from a display name before quoting it", () => {
    expect(formatAddress({ name: "Ada\u0000\nLovelace", email: "a@x.io" })).toBe(
      "AdaLovelace <a@x.io>",
    );
  });
});

describe("mailto URLs", () => {
  it("takes recipients from the path, the to header, or both", () => {
    expect(parseMailto("mailto:ann@example.com")).toMatchObject({
      to: [{ name: null, email: "ann@example.com" }],
    });
    expect(parseMailto("mailto:?to=bob@example.org").to).toEqual([
      { name: null, email: "bob@example.org" },
    ]);
    expect(parseMailto("mailto:ann@example.com?to=bob@example.org").to).toHaveLength(2);
    expect(parseMailto("mailto:ann@example.com,bob@example.org").to).toHaveLength(2);
  });

  it("reads cc, bcc, subject and body", () => {
    const m = parseMailto(
      "mailto:ann@example.com?cc=c@x.io&bcc=d@x.io&subject=Hello%20there&body=Line%20one",
    );
    expect(m.cc).toEqual([{ name: null, email: "c@x.io" }]);
    expect(m.bcc).toEqual([{ name: null, email: "d@x.io" }]);
    expect(m.subject).toBe("Hello there");
    expect(m.body).toBe("Line one");
  });

  it("is case-insensitive about headers and decodes plus as space", () => {
    const m = parseMailto("MAILTO:ann@example.com?SUBJECT=Re:+lunch&Body=see+you");
    expect(m.subject).toBe("Re: lunch");
    expect(m.body).toBe("see you");
  });

  it("keeps display names and survives malformed escapes", () => {
    expect(parseMailto("mailto:%22Smith%2C%20John%22%20%3Cj@x.io%3E").to).toEqual([
      { name: "Smith, John", email: "j@x.io" },
    ]);
    expect(parseMailto("mailto:ann@example.com?subject=100%").subject).toBe("100%");
  });

  it("decodes a header value once, not twice", () => {
    // URLSearchParams turns %25 into %, so this value is literally "100%20off";
    // a second decode would turn the literal %20 into a space.
    expect(parseMailto("mailto:x@y.io?subject=100%2520off").subject).toBe("100%20off");
  });

  it("keeps a + in the path, which is an address character and not a space", () => {
    expect(parseMailto("mailto:user+tag@x.io").to).toEqual([
      { name: null, email: "user+tag@x.io" },
    ]);
  });

  it("ignores headers it does not understand", () => {
    const m = parseMailto("mailto:ann@example.com?x-random=1&subject=Hi");
    expect(m.subject).toBe("Hi");
    expect(m.to).toHaveLength(1);
  });
});

/*
 * The one summariser a row and a header both read, so the two cannot name the
 * people on the same message differently: each person once, the reader's own
 * identity as `me`, and past `max` the rest as a count.
 */
describe("summarizeAddresses", () => {
  const ann = { name: "Ann", email: "ann@x.com" };
  const bob = { name: "Bob", email: "bob@y.com" };
  const carl = { name: "Carl", email: "carl@z.com" };

  afterEach(() => {
    setCatalog("en", { strings: {}, plurals: {} });
  });

  it("names one person once, however many times the message wrote them", () => {
    expect(summarizeAddresses([ann, bob], { fallback: "(unknown)" })).toBe("Ann, Bob");
    // The same person in To and in Cc is one name: the key is the address, so
    // a copy written with different case does not become a second person.
    expect(
      summarizeAddresses([ann, { name: "Ann again", email: "ANN@x.com" }], {
        fallback: "(unknown)",
      }),
    ).toBe("Ann");
    // Surrounding space is the same question `uniqueAddresses` answers in this
    // file: a trimmed, lowercased key, so the two agree on "the same address".
    expect(
      summarizeAddresses([ann, { name: "Ann again", email: " ann@x.com " }], {
        fallback: "(unknown)",
      }),
    ).toBe("Ann");
  });

  it("names the rest as a count once `max` is passed", () => {
    expect(summarizeAddresses([ann, bob, carl], { max: 2, fallback: "(unknown)" })).toBe(
      "Ann, Bob +1",
    );
    expect(summarizeAddresses([ann, bob, carl], { max: 3, fallback: "(unknown)" })).toBe(
      "Ann, Bob, Carl",
    );
  });

  it("names the reader's own identity as `me`", () => {
    setCatalog("it", { strings: { me: "io" }, plurals: {} });
    expect(
      summarizeAddresses([ann, bob], { own: ["ann@x.com"], fallback: "(unknown)" }),
    ).toBe("io, Bob");
  });

  it("says the fallback when there is nobody to name", () => {
    expect(summarizeAddresses([null, undefined], { fallback: "(unknown)" })).toBe(
      "(unknown)",
    );
    expect(summarizeAddresses([], { fallback: "(unknown)" })).toBe("(unknown)");
  });
});
