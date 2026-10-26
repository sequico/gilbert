import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import {
  DOCUMENT_TEXT_MAX,
  documentKind,
  imageMediaType,
  readDocument,
  SCANNED_PAGES_MAX,
} from "./documentText.js";

/**
 * The text a document holds (ADR 0038).
 *
 * Every format is exercised on a document **built here**, not on a fixture
 * somebody committed: a workbook and an ODS through the spreadsheet reader that
 * reads them, a .docx and an .odt as the zip each really is, a PDF written out
 * byte by byte, and a text file. What is pinned is the answer for each — the
 * words inside — and the two answers that are not text: a format nothing here
 * reads, and a document that will not open.
 */

/** A workbook with one named sheet, as a spreadsheet reader writes it. */
async function sheetBytes(bookType: "xlsx" | "ods"): Promise<Uint8Array> {
  const XLSX = (await import("@e965/xlsx")) as unknown as {
    utils: {
      book_new(): unknown;
      aoa_to_sheet(rows: unknown[][]): unknown;
      book_append_sheet(book: unknown, sheet: unknown, name: string): void;
    };
    write(book: unknown, opts: { type: "buffer"; bookType: string }): Uint8Array;
  };
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["Booking", "Shipper"],
      ["BK-1", "Maersk"],
    ]),
    "Inbound",
  );
  return new Uint8Array(XLSX.write(book, { type: "buffer", bookType }));
}

/** A Word file, as one really is: a zip whose `word/document.xml` is the text. */
async function docxBytes(text: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

/** An OpenDocument text, as one really is: a zip whose `content.xml` is the text. */
async function odtBytes(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("mimetype", "application/vnd.oasis.opendocument.text");
  zip.file(
    "content.xml",
    '<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:h>Intake</text:h><text:p>Answer the shipper within a day.</text:p></office:text></office:body></office:document-content>',
  );
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

/** A one-page PDF with a text layer, written out as the file really looks. */
function pdfBytes(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<</Type /Catalog /Pages 2 0 R>>",
    "<</Type /Pages /Kids [3 0 R] /Count 1>>",
    "<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources <</Font <</F1 5 0 R>>>>>>",
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<</Size ${objects.length + 1} /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/**
 * A two-page PDF: one page with a text layer and one without — the shape of a
 * signed contract whose cover is digital and whose pages are scans.
 */
function mixedPdfBytes(text: string): Uint8Array {
  const withText = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const empty = "";
  const objects = [
    "<</Type /Catalog /Pages 2 0 R>>",
    "<</Type /Pages /Kids [3 0 R 4 0 R] /Count 2>>",
    "<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources <</Font <</F1 7 0 R>>>>>>",
    "<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R>>",
    `<</Length ${withText.length}>>\nstream\n${withText}\nendstream`,
    `<</Length ${empty.length}>>\nstream\n${empty}\nendstream`,
    "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<</Size ${objects.length + 1} /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

test("a mixed PDF keeps its text page and sends only its scan to the model", async () => {
  /*
   * The common signed contract: a digital cover and scanned pages behind it. A
   * reader that looked at the document as a whole would answer the cover and
   * drop everything a person actually needs.
   */
  let looked = 0;
  const read = await readDocument(
    mixedPdfBytes("Booking 4417 confirmed"),
    "application/pdf",
    "contract.pdf",
    {
      readImage: async () => {
        looked += 1;
        return { text: "the scanned page, read by the model" };
      },
    },
  );
  assert.ok(read && !("problem" in read), "the document is readable");
  assert.match(read.text, /Booking 4417 confirmed/, "the text page stays text");
  assert.match(read.text, /read by the model/, "and the page without text was looked at");
  assert.equal(looked, 1, "only the page with no text layer was rendered");
});

test("a spreadsheet is read cell by cell, whichever format it is in", async () => {
  for (const bookType of ["xlsx", "ods"] as const) {
    const read = await readDocument(
      await sheetBytes(bookType),
      "application/octet-stream",
      `price-list.${bookType}`,
    );
    assert.ok(read && !("problem" in read), `${bookType} is readable`);
    assert.equal(read.kind, "sheet");
    assert.match(read.text, /# Inbound/, "the sheet is named");
    assert.match(read.text, /BK-1,Maersk/, "and its cells are in the text");
  }
});

test("a Word file is read as the text it holds", async () => {
  const read = await readDocument(
    await docxBytes("Answer the shipper within a day."),
    "application/octet-stream",
    "procedure.docx",
  );
  assert.ok(read && !("problem" in read));
  assert.equal(read.kind, "docx");
  assert.match(read.text, /Answer the shipper within a day\./);
});

test("an OpenDocument is read as its own content", async () => {
  const read = await readDocument(
    await odtBytes(),
    "application/octet-stream",
    "procedure.odt",
  );
  assert.ok(read && !("problem" in read));
  assert.equal(read.kind, "odf");
  assert.match(read.text, /Intake/);
  assert.match(read.text, /Answer the shipper within a day\./);
});

test("a PDF's text layer is read, and a text file is its own text", async () => {
  const pdf = await readDocument(
    pdfBytes("Booking 4417 confirmed"),
    "application/pdf",
    "confirmation.pdf",
  );
  assert.ok(pdf && !("problem" in pdf));
  assert.equal(pdf.kind, "pdf");
  assert.match(pdf.text, /Booking 4417 confirmed/);

  const plain = await readDocument(
    new TextEncoder().encode("a note in a file"),
    "text/plain",
    "note.txt",
  );
  assert.ok(plain && !("problem" in plain));
  assert.equal(plain.kind, "text");
  assert.equal(plain.text, "a note in a file");
});

test("what it cannot read answers so, and never the bytes", async () => {
  assert.equal(
    await readDocument(
      new Uint8Array([0x00, 0x01, 0x02]),
      "application/octet-stream",
      "x.bin",
    ),
    null,
    "a format nothing here reads has no text to give",
  );

  const broken = await readDocument(
    new TextEncoder().encode("not a zip at all"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "broken.docx",
  );
  assert.ok(broken && "problem" in broken, "a document that will not open says why");
  assert.match(broken.problem, /could not be read as docx/);
  assert.doesNotMatch(
    broken.problem,
    /not a zip at all/,
    "the bytes are never the answer",
  );
});

test("the type is taken from the MIME and then from the name", () => {
  assert.equal(documentKind("application/octet-stream", "x.PDF"), "pdf");
  assert.equal(documentKind("application/pdf", "no-extension"), "pdf");
  assert.equal(
    documentKind("application/vnd.oasis.opendocument.spreadsheet", "x"),
    "sheet",
  );
  assert.equal(documentKind("text/plain", "x.odt"), "text", "an explicit text type wins");
  assert.equal(documentKind("application/octet-stream", "x.exe"), null);
  assert.ok(DOCUMENT_TEXT_MAX > 0);
});

/** A one-page PDF with **no** text layer: the page is a scan to this build. */
function scannedPdfBytes(): Uint8Array {
  const objects = [
    "<</Type /Catalog /Pages 2 0 R>>",
    "<</Type /Pages /Kids [3 0 R] /Count 1>>",
    "<</Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R>>",
    "<</Length 0>>\nstream\n\nendstream",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<</Size ${objects.length + 1} /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

test("a PDF with no text layer is a scan: its pages go to the model, and nowhere without it", async () => {
  /*
   * A scanned page is a picture of a document. Nothing in this tree parses one
   * (owner decision 2026-10-18: no OCR engine), so the page is rendered to a
   * bitmap, encoded as a PNG and transcribed by the installation's model — and a
   * caller without that model is told so rather than handed an empty document.
   */
  const scanned = scannedPdfBytes();

  const blind = await readDocument(scanned, "application/pdf", "scan.pdf");
  assert.ok(blind && !("problem" in blind));
  assert.equal(
    blind.text,
    "",
    "with no reader for the picture, the text layer is what there is",
  );

  const seen: Array<{ type: string; data: Uint8Array }> = [];
  const read = await readDocument(scanned, "application/pdf", "scan.pdf", {
    readImage: async (image) => {
      seen.push(image);
      return { text: "Booking 4417 confirmed" };
    },
  });
  assert.ok(read && !("problem" in read));
  assert.equal(read.kind, "pdf");
  assert.match(read.text, /Booking 4417 confirmed/, "the page's words come back");
  assert.equal(seen.length, 1, "one page, one picture");
  assert.equal(seen[0]?.type, "image/png", "a real PNG, which is what the model takes");
  assert.deepEqual(
    [...(seen[0]?.data.subarray(0, 8) ?? [])],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "with the format's own signature",
  );
  assert.ok(SCANNED_PAGES_MAX > 0);
});

test("a picture's type is its bytes', not the sender's label", () => {
  /*
   * The live failure this pins: a WhatsApp pack labels every `.jpeg`
   * `application/octet-stream`, and the provider refused each one — "unsupported
   * image ... webp, png, jpeg, and gif" — while the bytes were a valid JPEG.
   */
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  assert.equal(
    imageMediaType("application/octet-stream", "WhatsApp Image 09.31.57.jpeg", jpeg),
    "image/jpeg",
    "the name answers when the type says nothing",
  );
  assert.equal(
    imageMediaType("application/octet-stream", "no extension", jpeg),
    "image/jpeg",
    "and the bytes answer when the name says nothing",
  );
  assert.equal(
    imageMediaType("image/png", "x.jpeg", jpeg),
    "image/jpeg",
    "the bytes answer before a label that names another format",
  );
  const webp = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);
  assert.equal(
    imageMediaType("application/octet-stream", "x.bin", webp),
    "image/webp",
    "a container format is read from its own marker",
  );
  assert.equal(
    imageMediaType("application/octet-stream", "x.bmp", new Uint8Array([0x42, 0x4d])),
    null,
    "a format the model does not take is named as one, not sent to be refused",
  );
});
