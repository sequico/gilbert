import assert from "node:assert/strict";
import { test } from "node:test";

process.env.STALWART_URL = "http://127.0.0.1:1";
process.env.APP_SECRET = "test-secret-for-ics-proxy";

const { redirectRefusal, safeFetch, safeFetchStatus } = await import("./imageproxy.js");
const { looksLikeCalendar } = await import("./icsproxy.js");

/**
 * Subscribing to a calendar makes the server fetch a URL a stranger published,
 * which is the second time this app knocks on a door somebody else chose. It
 * goes through the same guard as the first — these tests are about that guard
 * being reached, and about `webcal:` not being a way around it.
 */

test("a calendar URL is refused before any connection when it points somewhere private", async () => {
  for (const url of [
    "http://127.0.0.1/calendar.ics",
    "http://169.254.169.254/latest/meta-data/", // cloud metadata
    "http://[::1]/calendar.ics",
    "http://10.0.0.1/c.ics",
    "https://192.168.1.1/c.ics",
  ]) {
    const got = await safeFetch(url, 500);
    assert.equal(got, "forbidden_target", url);
  }
});

test("webcal: is treated as https rather than waved through", async () => {
  // Every subscription URL people are given is a webcal: one. It has to be
  // understood, and it must not be a way past the address check.
  const got = await safeFetch("webcal://127.0.0.1/calendar.ics", 500);
  assert.equal(got, "forbidden_target");
});

test("schemes that are not http, https or webcal are refused", async () => {
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.com/c.ics",
    "gopher://example.com",
    "data:text/calendar,BEGIN:VCALENDAR",
  ]) {
    const got = await safeFetch(url, 500);
    assert.equal(got, "bad_scheme", url);
  }
});

test("a URL carrying credentials is refused", async () => {
  // Credentials in a subscription URL would be sent by the server on the
  // reader's behalf to a host the reader may not have looked at.
  assert.equal(await safeFetch("http://user:pass@example.com/c.ics", 500), "bad_url");
});

// A redirect is a second URL nobody asked for, and it gets the same guard as
// the first. A target with credentials in the userinfo would have Node write an
// `Authorization: Basic …` header from it, so the proxy would send a credential
// it was never given -- and the initial-URL check does not cover this hop.
test("a redirect target is checked the way the first URL is", () => {
  assert.equal(
    redirectRefusal(new URL("http://user:pass@example.com/c.ics")),
    "bad_redirect",
  );
  assert.equal(
    redirectRefusal(new URL("https://user@example.com/c.ics")),
    "bad_redirect",
  );
  assert.equal(redirectRefusal(new URL("http://example.com:8080/c.ics")), "bad_redirect");
  assert.equal(redirectRefusal(new URL("ftp://example.com/c.ics")), "bad_redirect");
  assert.equal(redirectRefusal(new URL("https://example.com/c.ics")), null);
});

test("nonsense is refused rather than guessed at", async () => {
  for (const url of ["", "not a url", "://missing-scheme"]) {
    assert.equal(await safeFetch(url, 500), "bad_url", JSON.stringify(url));
  }
});

test("each refusal has a status that says which kind it was", () => {
  assert.equal(safeFetchStatus("forbidden_target"), 403);
  assert.equal(safeFetchStatus("bad_scheme"), 400);
  assert.equal(safeFetchStatus("bad_url"), 400);
  assert.equal(safeFetchStatus("bad_port"), 400);
  assert.equal(safeFetchStatus("bad_redirect"), 400);
  assert.equal(safeFetchStatus("dns_failure"), 502);
  assert.equal(safeFetchStatus("fetch_failed"), 502);
});

// Anyone may hold a public address and probe an arbitrary port with it, which
// turns this route into an anonymising port scanner: the answer says whether
// something listens there. Only the two web ports are reached, so there is
// nothing to scan; the default ports are elided by URL and must still pass.
test("only the standard web ports are reached", async () => {
  assert.equal(await safeFetch("http://example.com:8080/calendar.ics", 500), "bad_port");
  assert.equal(await safeFetch("https://example.com:8443/calendar.ics", 500), "bad_port");
  assert.equal(await safeFetch("http://example.com:22/calendar.ics", 500), "bad_port");
  assert.equal(
    await safeFetch("http://127.0.0.1/calendar.ics", 500),
    "forbidden_target",
    "port 80 is allowed; the address is what refuses this one",
  );
});

// The type header is chosen by the server being fetched, so a public host can
// answer with `text/plain` and any bytes it likes. The document having to open
// with `BEGIN:VCALENDAR` is what makes this a calendar fetch.
test("a body is treated as a calendar only when it says it is one", () => {
  assert.equal(looksLikeCalendar("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"), true);
  assert.equal(looksLikeCalendar("\uFEFFBEGIN:VCALENDAR\n"), true, "a BOM is skipped");
  for (const not of [
    "<!doctype html><title>404</title>",
    '{"error":"not found"}',
    "",
    "  \n",
  ]) {
    assert.equal(looksLikeCalendar(not), false, JSON.stringify(not));
  }
});
