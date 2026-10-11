import assert from "node:assert/strict";
import { test } from "node:test";
import zlib from "node:zlib";
import * as XLSX from "@e965/xlsx";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  DOCUMENT_ARCHIVE_BYTES_MAX,
  DOCUMENT_TEXT_MAX,
  documentContent,
  documentKindOf,
  readDocument,
} from "./documentFamily.js";

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

test("a PDF whose text layer is past the character ceiling is cut, and says so", async () => {
  /*
   * A PDF is bounded by pages for what is looked at, but its text layer can
   * still be longer than the character ceiling every other kind is held to: it
   * is cut there and the cut is reported, rather than handed over whole while
   * a text file or a workbook is not.
   */
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  // Forty lines a page, each well past the shortest text a layer may carry.
  const line = "abcdefghij ".repeat(20);
  for (let page = 0; page < 40; page++) {
    const sheet = document.addPage([600, 800]);
    for (let row = 0; row < 40; row++) {
      sheet.drawText(line, { x: 10, y: 780 - row * 18, size: 8, font });
    }
  }
  const read = await readDocument(await document.save(), "pdf", 40);
  assert.equal(read.text.length, DOCUMENT_TEXT_MAX, "the text is cut at the ceiling");
  assert.equal(
    read.truncated,
    true,
    "a run handed the beginning of the page text has to be told so",
  );
});

/* ------------------------------------------------------------------ */
/* Text and spreadsheets                                               */
/* ------------------------------------------------------------------ */

/** A workbook of `sheets` sheets, one row each, written as `.xlsx` or `.xls`. */
function workbook(sheets: string[], bookType: "xlsx" | "xls"): Uint8Array {
  const book = XLSX.utils.book_new();
  for (const name of sheets) {
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ["Cliente", "Importo"],
        [name, 1250],
      ]),
      name,
    );
  }
  return new Uint8Array(XLSX.write(book, { type: "buffer", bookType }) as ArrayBuffer);
}

test("the kinds this family reads are decided by name first and media type second", () => {
  assert.equal(documentKindOf("fatture.xlsx"), "sheet");
  assert.equal(documentKindOf("fatture.XLS"), "sheet");
  assert.equal(documentKindOf("export.csv"), "text");
  assert.equal(documentKindOf("note.txt"), "text");
  assert.equal(documentKindOf("dati", "text/csv"), "text");
  assert.equal(documentKindOf("dati", "application/vnd.ms-excel"), "sheet");
  assert.equal(
    documentKindOf(
      "dati",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
    "sheet",
  );
  assert.equal(documentKindOf("relazione.docx"), "docx");
  assert.equal(documentKindOf("contratto.pdf"), "pdf");
  assert.equal(
    documentKindOf("archivio.zip"),
    null,
    "a kind nobody named is refused rather than guessed at",
  );
});

test("a text file is read as it stands, and a byte-order mark is not text", async () => {
  const bytes = new TextEncoder().encode("\uFEFFcliente;importo\nACME;1250\n");
  const read = await readDocument(bytes, "text", 8);
  assert.equal(read.kind, "text");
  assert.equal(read.text, "cliente;importo\nACME;1250");
  assert.equal(read.truncated, false);
  assert.deepEqual(read.pixelPages, [], "text has no pages that could be images");
});

test("text past the character ceiling is the beginning of it, and says so", async () => {
  const bytes = new TextEncoder().encode("x".repeat(DOCUMENT_TEXT_MAX + 5000));
  const read = await readDocument(bytes, "text", 8);
  assert.equal(read.text.length, DOCUMENT_TEXT_MAX);
  assert.equal(
    read.truncated,
    true,
    "a run handed the beginning of a file has to be told that is what it got",
  );
});

test("a workbook is one page per sheet, read the same as .xls and as .xlsx", async () => {
  for (const bookType of ["xlsx", "xls"] as const) {
    const read = await readDocument(workbook(["Fatture", "Note"], bookType), "sheet", 8);
    assert.equal(read.kind, "sheet", `${bookType} is the same kind as the other`);
    assert.equal(read.pages, 2, `${bookType} counts a workbook's sheets`);
    assert.equal(read.looked, 2);
    assert.equal(read.truncated, false);
    assert.match(read.text, /# Fatture/);
    assert.match(read.text, /# Note/);
    assert.match(read.text, /Importo/);
    assert.ok(read.text.includes("\t"), "a cell is separated from the next by a tab");
  }
});

test("a workbook past the page bound is its first sheets, and the rest are unread", async () => {
  const read = await readDocument(workbook(["Uno", "Due", "Tre"], "xlsx"), "sheet", 2);
  assert.equal(read.pages, 3, "the workbook's own size is still known");
  assert.equal(read.looked, 2);
  assert.match(read.text, /# Uno/);
  assert.match(read.text, /# Due/);
  assert.ok(!read.text.includes("# Tre"), "a sheet past the bound contributes nothing");
});

/**
 * A one-entry ZIP whose own directory **declares** an uncompressed size.
 *
 * The payload is tiny; what makes it a bomb is the size the archive claims for
 * it, which is what a bounded reader must read before expanding anything. A
 * real deflate bomb could not be built here without first allocating the bytes
 * it expands to, which is the very thing the bound exists to avoid.
 */
function declaredZip(name: string, uncompressed: number): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const content = new TextEncoder().encode("<w:document/>");
  const crc = zlib.crc32(content);
  const local = new Uint8Array(30 + nameBytes.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint32(14, crc, true);
  lv.setUint32(18, content.length, true);
  lv.setUint32(22, uncompressed, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, content.length, true);
  cv.setUint32(24, uncompressed, true);
  cv.setUint16(28, nameBytes.length, true);
  central.set(nameBytes, 46);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length + content.length, true);
  return new Uint8Array([...local, ...content, ...central, ...end]);
}

test("an archive that unpacks past the ceiling is refused before it is expanded", async () => {
  /*
   * A `.docx` and a `.xlsx` are ZIPs, and the library that reads one decompresses
   * it in memory before a character of it is bounded: a small archive that claims
   * a huge uncompressed total would OOM the process, so the total is refused
   * from the archive's own directory, before anything is expanded. Removing the
   * bound hands the bytes to the reader, which cannot read this fixture — so the
   * assertion fails rather than the process dying.
   */
  const bomb = declaredZip("word/document.xml", DOCUMENT_ARCHIVE_BYTES_MAX + 1);
  await assert.rejects(() => readDocument(bomb, "docx", 8), /document_too_large/);
  await assert.rejects(() => readDocument(bomb, "sheet", 8), /document_too_large/);
});

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

/** The smallest valid PNG: a signature and nothing this family looks past. */
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
/** A JPEG's own magic bytes, and nothing more. */
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]);

test("an image is a kind of its own, by name and by media type", () => {
  assert.equal(documentKindOf("scansione.png"), "image");
  assert.equal(documentKindOf("foto.JPG"), "image");
  assert.equal(documentKindOf("foto.jpeg"), "image");
  assert.equal(documentKindOf("animazione.gif"), "image");
  assert.equal(documentKindOf("moderna.webp"), "image");
  assert.equal(documentKindOf("dati", "image/png"), "image");
});

test("an image carries no text layer at all: one page, all of it pixels", async () => {
  const read = await readDocument(PNG_BYTES, "image", 8);
  assert.equal(read.kind, "image");
  assert.equal(read.pages, 1);
  assert.equal(read.looked, 1);
  assert.equal(read.text, "", "an image has nothing of its own to read as text");
  assert.deepEqual(read.pixelPages, [1], "the one page it has is pixels, not text");
  assert.equal(read.truncated, false);
});

test("an image reaches the call as its own bytes, mislabelled as neither PNG nor anything else", async () => {
  const content = await documentContent(JPEG_BYTES, "image", 8);
  assert.equal(content.images.length, 1, "the one page an image carries is handed over");
  assert.equal(content.images[0]?.page, 1);
  assert.deepEqual(
    content.images[0]?.png,
    JPEG_BYTES,
    "the bytes travel through unchanged: nothing here decodes or re-encodes a pixel",
  );
  assert.equal(
    content.images[0]?.mime,
    "image/jpeg",
    "the MIME is read from the bytes' own magic number, not guessed from a name",
  );
  assert.equal(content.omitted, 0);
  assert.equal(content.unreadPages, 0);
});

test("a bound of zero pages hands an image over the same way it hands over none of a PDF", async () => {
  const content = await documentContent(PNG_BYTES, "image", 0);
  assert.deepEqual(content.images, [], "no page is rendered past the bound");
  assert.equal(content.omitted, 1, "the one page the file has was left out, honestly");
});

test("a deployment without vision reads no image, image file included", async () => {
  const content = await documentContent(PNG_BYTES, "image", 8, { vision: false });
  assert.deepEqual(content.images, []);
});

test("a file named as an image but carrying none of the four formats is refused, not mislabelled", async () => {
  await assert.rejects(
    () => documentContent(new TextEncoder().encode("not a picture"), "image", 8),
    /unreadable_document/,
  );
});
