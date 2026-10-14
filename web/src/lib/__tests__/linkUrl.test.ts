import { describe, expect, it } from "vitest";
import { isLinkUrl } from "../linkUrl";
import { readSource } from "./readSource";

/**
 * A stored URL is drawn as a link only when the app will follow it.
 *
 * A contact's website and an event's virtual location come from outside the
 * writer that drew them, so the decision cannot live at the field: it is made
 * once, here, and both surfaces ask it.
 */
describe("isLinkUrl", () => {
  it("accepts the schemes the app links", () => {
    expect(isLinkUrl("https://example.com/a?b=1")).toBe(true);
    expect(isLinkUrl("http://example.com")).toBe(true);
    expect(isLinkUrl("mailto:ann@example.com")).toBe(true);
    expect(isLinkUrl("tel:+390719206262")).toBe(true);
  });

  it("refuses a value that would run instead of navigating", () => {
    for (const value of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
    ]) {
      expect(isLinkUrl(value)).toBe(false);
    }
  });

  it("does not guess at a scheme", () => {
    for (const value of ["", "   ", "example.com", "ann@example.com"]) {
      expect(isLinkUrl(value)).toBe(false);
    }
  });

  it("is asked before either surface draws an anchor", () => {
    // The anchor itself is the element it always was; what is pinned is that it
    // sits behind the guard, whatever the view's formatting around it.
    const contacts = readSource("src/views/contacts/ContactsView.tsx");
    expect(contacts).toMatch(/isLinkUrl\(l\.uri\)[\s\S]{0,80}<a href=\{l\.uri\}/);

    const calendar = readSource("src/views/calendar/EventPopover.tsx");
    expect(calendar).toMatch(/isLinkUrl\(vloc\.uri\)[\s\S]{0,80}<a href=\{vloc\.uri\}/);
  });
});
