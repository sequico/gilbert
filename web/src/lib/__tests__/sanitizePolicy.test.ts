import { describe, expect, it } from "vitest";
import {
  FORBID_ATTR,
  FORBID_TAGS,
  OURS_FORBID_TAGS,
  sanitizeEditorHtml,
  sanitizeEmailHtml,
} from "../html";
import { renderMarkdown } from "../markdown";

/**
 * One blocklist, three surfaces.
 *
 * The three sanitised surfaces used to carry their own copy of the list of tags
 * nobody may render, and the copies had drifted: the Markdown renderer still
 * allowed `option`, `slot` and `dialog`, which the mail body's list had grown to
 * forbid. A policy held in three places is a policy that agrees until it does
 * not, and this is the test that says so: it drives each surface with a
 * specimen that carries the tag, and fails the moment a surface stops asking
 * the shared list.
 */

interface Surface {
  name: string;
  sanitize: (html: string) => string;
  forbidTags: readonly string[];
  forbidAttrs: readonly string[];
  /** Whether a `style` attribute survives — the one difference between them. */
  keepsStyleAttr: boolean;
}

const surfaces: Surface[] = [
  {
    name: "a mail body",
    sanitize: (html) => sanitizeEmailHtml(html).html,
    forbidTags: FORBID_TAGS,
    forbidAttrs: FORBID_ATTR,
    keepsStyleAttr: true,
  },
  {
    name: "the composer",
    sanitize: sanitizeEditorHtml,
    forbidTags: OURS_FORBID_TAGS,
    forbidAttrs: FORBID_ATTR,
    keepsStyleAttr: true,
  },
  {
    name: "a Markdown file",
    sanitize: renderMarkdown,
    forbidTags: OURS_FORBID_TAGS,
    forbidAttrs: [...FORBID_ATTR, "style"],
    keepsStyleAttr: false,
  },
];

/** A specimen around one hostile element, with text either side of it. */
const specimen = (element: string): string =>
  `<p>before</p>${element}<p>after</p>`;

const parse = (html: string): Document =>
  new DOMParser().parseFromString(html, "text/html");

describe("the sanitising policy", () => {
  for (const surface of surfaces) {
    describe(surface.name, () => {
      for (const tag of surface.forbidTags) {
        it(`renders no <${tag}>`, () => {
          const out = surface.sanitize(specimen(`<${tag} id="probe">x</${tag}>`));
          const doc = parse(out);
          expect(doc.querySelector(tag)).toBeNull();
          // The rest of the message is still there: the tag went, not the text.
          expect(doc.body.textContent).toContain("before");
          expect(doc.body.textContent).toContain("after");
        });
      }

      for (const attr of surface.forbidAttrs) {
        it(`keeps no ${attr} attribute`, () => {
          const out = surface.sanitize(
            specimen(`<div id="probe" ${attr}="v">x</div>`),
          );
          expect(parse(out).querySelector("#probe")?.hasAttribute(attr)).toBe(
            false,
          );
        });
      }

      it(`${surface.keepsStyleAttr ? "keeps" : "drops"} a style attribute`, () => {
        const out = surface.sanitize(
          specimen('<div id="probe" style="color:red">x</div>'),
        );
        expect(parse(out).querySelector("#probe")?.hasAttribute("style")).toBe(
          surface.keepsStyleAttr,
        );
      });
    });
  }

  it("is one list, not one per surface", () => {
    // The derivation is the whole difference between the surfaces: no surface
    // holds a list of its own to edit.
    expect([...OURS_FORBID_TAGS]).toEqual([...FORBID_TAGS, "style"]);
    expect(new Set(FORBID_TAGS).size).toBe(FORBID_TAGS.length);
    expect(new Set(FORBID_ATTR).size).toBe(FORBID_ATTR.length);
  });
});
