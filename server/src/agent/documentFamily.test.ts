import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { documentContent, readDocument } from "./documentFamily.js";

/** A PDF of `pages` pages, each carrying real, readable text. */
async function textPdf(pages: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let page = 0; page < pages; page++) {
    const sheet = document.addPage([300, 200]);
    sheet.drawText(`This is the real text of page ${page + 1}, long enough to count.`, {
      x: 20,
      y: 100,
      size: 12,
      font,
    });
  }
  return document.save();
}

test("a bound of zero pages reads no text, the same as it renders no image", async () => {
  // Business logic review finding: `documentContent` correctly reads zero
  // images for a `maxPages` of zero, but the PDF text layer was floored to at
  // least one page regardless of the bound — an installation that set its
  // page bound to zero still had page one's text read and billed.
  const bytes = await textPdf(3);

  const read = await readDocument(bytes, "pdf", 0);
  assert.equal(read.pages, 3, "the page count is still known");
  assert.equal(read.looked, 0, "nothing was actually read");
  assert.equal(read.text, "", "no text is handed over past the bound");
  assert.deepEqual(read.pixelPages, [], "no page is reported as image-only either");

  const content = await documentContent(bytes, "pdf", 0);
  assert.deepEqual(content.images, [], "no image is rendered past the bound");
  assert.equal(content.unreadPages, 3, "every page is honestly reported as unread");
});

test("a bound past the page count reads every page, not one more", async () => {
  const bytes = await textPdf(2);
  const read = await readDocument(bytes, "pdf", 10);
  assert.equal(read.looked, 2, "the bound never inflates past what the document has");
  assert.match(read.text, /page 1/);
  assert.match(read.text, /page 2/);
});
