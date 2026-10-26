/**
 * One message printed as a PDF in the account's own Files (ADR 0038).
 *
 * The agent could save text and nothing else, and a person asking for a mail "as a
 * PDF" asks for the page a printer gives. This tool reads the message through the
 * same door `mail.read` uses, composes the page (`agent/pdf.ts`), and files it where
 * the call names — so the PDF is a document in Files, with an id a later step can
 * attach or link, and never bytes in a model's answer.
 *
 * It composes and files; it never replaces. A path already taken is refused, like
 * every write of a new document, and text the standard font cannot carry is refused
 * by character rather than printed as a question mark.
 */
import { addressLine, messagePdf, PdfTextError } from "../pdf.js";
import { argsRecord, textArg } from "./args.js";
import { defineTool, ToolError } from "./define.js";
import { writeNewFile } from "./files.js";
import { addressesIn, messageBodyOf, messageDocument } from "./mail.js";

export const printMessage = defineTool({
  name: "mail.print",
  description:
    "Print one message of this account as a PDF in its own Files, at `path` — " +
    "`Mail/2026/BK-42.pdf`. The page carries the subject, who wrote it and to whom, " +
    "the date, and the message's text, wrapped onto A4 pages. The file is a document " +
    "like any other in Files: `files.read` reads it, a draft can attach it. A path " +
    "that already holds a document is refused, and text the PDF's standard font " +
    "cannot carry is refused by character rather than printed as a question mark.",
  authority: "reversible",
  writes: true,
  surface: "files",
  spend: { steps: 1 },
  args: {
    id: { type: "text", about: "a message id, from open (messages)" },
    path: { type: "text", about: "where in Files, ending .pdf" },
  },
  parse: (raw: unknown) => {
    const args = argsRecord(raw);
    return { id: textArg(args, "id"), path: textArg(args, "path") };
  },
  run: async ({ ctx, accountId }, { id, path }) => {
    const message = await messageDocument(ctx, accountId, id);
    const at =
      typeof message.receivedAt === "string"
        ? message.receivedAt
        : typeof message.sentAt === "string"
          ? message.sentAt
          : "";
    /*
     * The page carries the text part, or says what it carries instead: a preview is
     * marked as one, and a body the server cut at the read's own bound says so. A page
     * that silently held a hundred characters would look like the whole message.
     */
    const body = messageBodyOf(message);
    const preview = typeof message.preview === "string" ? message.preview.trim() : "";
    const text = body
      ? `${body.text}${
          body.truncated
            ? "\n\n[the message is longer than this build reads; the rest is in the mail client]"
            : ""
        }`
      : preview
        ? `${preview}\n\n[preview only: this message carries no text part]`
        : "";
    let bytes: Uint8Array;
    try {
      bytes = await messagePdf({
        subject: typeof message.subject === "string" ? message.subject : "",
        from: addressLine(addressesIn(message.from)),
        to: addressLine(addressesIn(message.to)),
        cc: addressLine(addressesIn(message.cc)),
        at,
        text,
      });
    } catch (err) {
      if (err instanceof PdfTextError)
        throw new ToolError(
          "pdf_characters",
          `This message cannot be printed as a PDF: ${err.message}. Save it as text, or print it from the client.`,
          422,
        );
      throw err;
    }
    const target = path.toLowerCase().endsWith(".pdf") ? path : `${path}.pdf`;
    const written = await writeNewFile(ctx, accountId, target, bytes, "application/pdf");
    return { ...written, bytes: bytes.byteLength };
  },
});
