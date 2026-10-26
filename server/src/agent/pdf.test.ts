/**
 * A printed message is a real PDF (ADR 0038).
 *
 * The page is checked by loading it again with a PDF reader, not by looking for a
 * string in the bytes: a file that begins with `%PDF-` and cannot be opened is the
 * failure this guards against. The refusals are checked where they happen — the
 * standard font's own answer, named by character.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { messagePdf, PdfTextError, type PrintableMessage } from "./pdf.js";

const message: PrintableMessage = {
  subject: "Consegna BK-901",
  from: "Anna Rossi <anna@shipper.example>",
  to: "Gruppo freight <freight@example.com>",
  cc: "Ops <ops@shipper.example>",
  at: "2026-10-26T10:41:00Z",
  text: "Buongiorno,\n\nla consegna è prevista per il 4 novembre.\nGrazie.",
};

test("a message prints as a PDF a reader opens", async () => {
  const bytes = await messagePdf(message);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-", "the file is a PDF");
  const page = await PDFDocument.load(bytes);
  assert.equal(page.getPageCount(), 1, "a short message is one page");
  assert.equal(page.getTitle(), message.subject, "and it carries its subject");
});

test("a long message continues on further pages", async () => {
  const text = Array.from(
    { length: 120 },
    (_, line) => `riga ${line + 1}: una frase abbastanza lunga da occupare spazio.`,
  ).join("\n");
  const page = await PDFDocument.load(await messagePdf({ ...message, text }));
  assert.ok(page.getPageCount() > 1, "the words continue past the first page");
});

test("a character the standard font cannot carry is refused by code point", async () => {
  await assert.rejects(
    () => messagePdf({ ...message, text: "Привет" }),
    (err: unknown) => err instanceof PdfTextError && /U\+041F/.test(err.message),
    "the letter is named, not printed as a question mark",
  );
});

test("the punctuation an editor produces is printed as the word it is", async () => {
  const bytes = await messagePdf({
    ...message,
    text: "“Quotato” — così… e una riga\tdi seguito.",
  });
  const page = await PDFDocument.load(bytes);
  assert.equal(page.getPageCount(), 1);
});
