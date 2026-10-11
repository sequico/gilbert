import { describe, expect, it } from "vitest";
import { htmlToText, quoteText, replySubject, stripControls, textToHtml } from "../text";

describe("text helpers", () => {
  it("linkifies and escapes", () => {
    const html = textToHtml("see <https://x.io/a?b=1> now");
    expect(html).toContain("&lt;");
    expect(html).toContain('<a href="https://x.io/a?b=1"');
  });
  it("colors quote levels", () => {
    expect(textToHtml("> hi\n>> there")).toContain('class="q1"');
    expect(textToHtml("> hi\n>> there")).toContain('class="q2"');
  });
  it("converts html to text", () => {
    const t = htmlToText(
      "<p>Hello <b>world</b></p><ul><li>one</li><li>two</li></ul><blockquote>q</blockquote><a href='https://a.b'>link</a>",
    );
    expect(t).toContain("Hello world");
    expect(t).toContain("- one");
    expect(t).toContain("> q");
    expect(t).toContain("link <https://a.b>");
  });
  it("quotes and subjects", () => {
    expect(quoteText("a\n> b")).toBe("> a\n>> b");
    expect(replySubject("Re: Hi", "Re")).toBe("Re: Hi");
    expect(replySubject("Fwd: Hi", "Re")).toBe("Re: Hi");
    expect(replySubject("Hi", "Fwd")).toBe("Fwd: Hi");
  });
  it("converts deeply nested html without taking the stack down", () => {
    // Deep enough that a recursive walk overflows the stack; the explicit job
    // stack carries it. Building the DOM itself is the slow half, so this
    // takes a wider timeout than the default.
    const depth = 2000;
    const deep = `${"<div>".repeat(depth)}x${"</div>".repeat(depth)}`;
    expect(htmlToText(deep)).toContain("x");
  }, 15_000);
  it("strips C0 controls and DEL but keeps tab", () => {
    expect(stripControls("a\u0000b\tc\nd\u007Fe")).toBe("ab\tcde");
  });
});
