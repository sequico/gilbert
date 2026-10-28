// @vitest-environment node
import { describe, expect, it } from "vitest";
import { appNameFor, DEFAULT_APP_NAME } from "@/lib/brand";

/*
 * The name an instance calls itself.
 *
 * `APP_NAME` is a runtime variable, so every place showing the name asks the
 * server rather than having it written in; the sign-in page fetches
 * `/api/config` for it. `appNameFor` is the one answer a session's flag gets,
 * and these pin the shape of that answer rather than the name.
 */

describe("appNameFor", () => {
  it("uses what the session says", () => {
    expect(appNameFor({ gilbert: { appName: "Acme Mail" } })).toBe("Acme Mail");
  });

  it("falls back when the request failed", () => {
    // A sign-in form with no name on it is worse than one with the wrong name.
    expect(appNameFor(null)).toBe(DEFAULT_APP_NAME);
    expect(appNameFor(undefined)).toBe(DEFAULT_APP_NAME);
    expect(appNameFor({})).toBe(DEFAULT_APP_NAME);
    expect(appNameFor({ gilbert: {} })).toBe(DEFAULT_APP_NAME);
  });

  it("falls back on a name that is empty, only spaces, or not a string", () => {
    expect(appNameFor({ gilbert: { appName: "" } })).toBe(DEFAULT_APP_NAME);
    expect(appNameFor({ gilbert: { appName: "   " } })).toBe(DEFAULT_APP_NAME);
    expect(appNameFor({ gilbert: { appName: 42 } })).toBe(DEFAULT_APP_NAME);
  });

  it("keeps a name whose edge whitespace is the deployment's own business", () => {
    // A leading space in a configured name is the operator's to see; only a
    // name with nothing in it is a missing answer.
    expect(appNameFor({ gilbert: { appName: " Acme Mail " } })).toBe(" Acme Mail ");
  });
});
