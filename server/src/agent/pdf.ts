/**
 * A message as a real PDF (ADR 0038).
 *
 * The agent can save text; a person who asks for a mail "as a PDF" means the page a
 * printer would give: the headers, a rule, and the words wrapped onto pages. The page
 * is written here, once, so the tool that prints a message and anything later reading
 * the same document draw the same thing.
 *
 * **The font is the standard one, and the text must fit it.** A PDF's built-in
 * Helvetica carries WinAnsi — Latin-1 plus the punctuation a European mail uses — and
 * this build ships no font file to embed: a character outside that set is refused with
 * its code point named (`PdfTextError`), never replaced by a question mark, because a
 * page that silently loses a word is worse than a tool that says it cannot print this
 * one.
 *
 * `shortcut: WinAnsi only, so Cyrillic, Greek and CJK text is refused; embeddings and
 * a bundled Unicode font are the upgrade when a group needs to print those.`
 */
import { PDFDocument, type PDFFont, rgb, StandardFonts } from "pdf-lib";

/** One message, as it is printed: what the page says above the words. */
export interface PrintableMessage {
  subject: string;
  from: string;
  to: string;
  cc?: string;
  /** The moment it arrived, as the account states it. */
  at: string;
  text: string;
}

/** A4, in points: the page a printer gives when nobody says otherwise. */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;

const TITLE_SIZE = 14;
const TITLE_LEADING = 18;
const META_SIZE = 9;
const META_LEADING = 12;
const BODY_SIZE = 10.5;
const BODY_LEADING = 15;

/** The character the standard font cannot print, so the caller can say which. */
export class PdfTextError extends Error {
  constructor(readonly character: string) {
    const codePoint = character.codePointAt(0) ?? 0;
    super(
      `the standard PDF font cannot print "${character}" (U+${codePoint
        .toString(16)
        .toUpperCase()
        .padStart(4, "0")})`,
    );
    this.name = "PdfTextError";
  }
}

/**
 * The typography a mail client's editor produces, mapped to what the font carries:
 * curly quotes, dashes and ellipses become their plain forms rather than a refusal,
 * because they are the same words.
 */
function plainText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
      .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
      .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
      .replace(/[\u2013\u2014\u2212]/g, "-")
      .replace(/\u2026/g, "...")
      .replace(/\u00a0/g, " ")
      .replace(/\t/g, "    ")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters have no glyph.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  );
}

/**
 * Refuse the text when a character of it has no glyph, naming the first one.
 *
 * Called per paragraph (a newline is not a character a page draws, and the standard
 * font refuses it as readily as a letter it does not carry).
 */
function assertPrintable(font: PDFFont, text: string): void {
  try {
    font.encodeText(text);
    return;
  } catch {
    for (const character of text) {
      try {
        font.encodeText(character);
      } catch {
        throw new PdfTextError(character);
      }
    }
    // A string the font refused as a whole while accepting each character of it is
    // not a case this build knows how to explain; it is still not printed.
    throw new PdfTextError("?");
  }
}

/** One paragraph cut into lines that fit `width`, breaking a word too long for it. */
function linesOf(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) {
        line = next;
        continue;
      }
      if (line) out.push(line);
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > width) {
        let cut = rest.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width)
          cut -= 1;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    if (line) out.push(line);
  }
  return out;
}

/** The address list of a header, as `Name <address>`, one entry each. */
export function addressLine(
  list: ReadonlyArray<{ email: string; name?: string }>,
): string {
  return list
    .map((one) => (one.name ? `${one.name} <${one.email}>` : one.email))
    .join(", ");
}

/**
 * The message as a PDF: title, headers, a rule, and the words, paginated.
 *
 * The bytes are complete when the promise resolves; nothing is written anywhere by
 * this function, so a caller that cannot file the document leaves no half a file.
 */
export async function messagePdf(message: PrintableMessage): Promise<Uint8Array> {
  const subject = plainText(message.subject.trim()) || "(no subject)";
  const meta = [
    `From: ${plainText(message.from)}`,
    `To: ${plainText(message.to)}`,
    ...(message.cc ? [`Cc: ${plainText(message.cc)}`] : []),
    `Date: ${plainText(message.at)}`,
  ];
  const words = plainText(message.text);
  const body = words.trim() ? words : "(this message carries no text part)";

  const doc = await PDFDocument.create();
  doc.setTitle(subject);
  doc.setCreator("Gilbert");
  doc.setProducer("Gilbert");
  doc.setCreationDate(new Date());
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const width = PAGE_WIDTH - MARGIN * 2;
  /*
   * The check comes before anything is measured: the font refuses an unencodable
   * character while measuring it, and a page must never be half written when it does.
   */
  for (const paragraph of [subject, ...meta, ...body.split("\n")])
    assertPrintable(font, paragraph);
  const title = linesOf(subject, bold, TITLE_SIZE, width);
  const metaLines = meta.flatMap((one) => linesOf(one, font, META_SIZE, width));
  const bodyLines = linesOf(body, font, BODY_SIZE, width);

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;
  const room = (needed: number): void => {
    if (y - needed >= MARGIN) return;
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  };

  for (const line of title) {
    room(TITLE_LEADING);
    page.drawText(line, { x: MARGIN, y, size: TITLE_SIZE, font: bold });
    y -= TITLE_LEADING;
  }
  y -= 4;
  for (const line of metaLines) {
    room(META_LEADING);
    page.drawText(line, {
      x: MARGIN,
      y,
      size: META_SIZE,
      font,
      color: rgb(0.35, 0.35, 0.35),
    });
    y -= META_LEADING;
  }
  y -= 6;
  room(BODY_LEADING);
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 0.5,
    color: rgb(0.8, 0.8, 0.8),
  });
  y -= BODY_LEADING;
  for (const line of bodyLines) {
    if (line) {
      room(BODY_LEADING);
      page.drawText(line, { x: MARGIN, y, size: BODY_SIZE, font });
    }
    y -= BODY_LEADING;
  }

  return await doc.save();
}
