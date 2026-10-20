import { deflateSync } from "node:zlib";

/**
 * The text a document holds (ADR 0031).
 *
 * The agent works in a company's own account, and what it is asked to act on
 * usually arrives as a document: a purchase order as a PDF, a price list as a
 * spreadsheet, a procedure as a Word file. Handing those bytes to a model as
 * though they were prose is handing it noise — so the formats this product
 * handles are read here, one door for the reading tool and for anything else
 * that has to say what a file is about.
 *
 * **The type is read from the MIME and then the name**, because a file's type is
 * what somebody's client said it was: a `.pdf` that arrived as
 * `application/octet-stream` is still a PDF, and a text file a browser labelled
 * `application/octet-stream` is still text. A format nothing here knows answers
 * `null`, which is the honest answer for "this is not something I can read" —
 * never the bytes, and never an empty string that reads as a document with
 * nothing in it.
 *
 * **Bounds.** What comes out is capped at `DOCUMENT_TEXT_MAX`, and the extraction
 * stops at the cap rather than building the whole text and cutting it: a sheet of
 * twenty megabytes expands to hundreds in memory, and the server that reads it is
 * the one serving the app. `shortcut: the cap is a character count, not a page
 * count, so a table that is one page of numbers can still fill it; upgrade by
 * reporting where the cut fell if a run ever needs the rest.`
 *
 * **A page with no text is a picture.** A PDF page whose text layer is empty is
 * rendered by `pdfium` and handed to the installation's model, whose eyes read it
 * — the same path as an image attachment. A mixed document is read page by page:
 * the text pages as text, the scans as pictures, up to `SCANNED_PAGES_MAX` pages
 * transcribed. A password-protected PDF is refused by the reader, and the tool
 * says so.
 */

/** How much text one document may contribute to a call. */
export const DOCUMENT_TEXT_MAX = 200_000;

/** What a document's text is, and how it was read, or why it could not be. */
type DocumentRead = { text: string; kind: DocumentKind };

/** The formats this build reads inside. */
type DocumentKind = "text" | "pdf" | "docx" | "sheet" | "odf" | "image";

/**
 * **DOCX** — Word's format is a zip of XML parts, and the text is `word/document.xml`.
 *
 * `mammoth` reads it properly (runs, tables, list markers) rather than by
 * stripping tags, which is what makes the answer prose instead of a soup of
 * element names.
 */
async function docxText(bytes: Uint8Array): Promise<string> {
  const mammoth = (await import("mammoth")) as unknown as {
    extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
  };
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return value;
}

/**
 * **Sheets** — xlsx, xls, ods (and csv through the same reader) as text.
 *
 * One block per sheet, named, with the cells as a table of comma-separated
 * values: what a person would copy out of the spreadsheet, and what a model can
 * follow, without a second spreadsheet engine in this tree.
 */
async function sheetText(bytes: Uint8Array): Promise<string> {
  const XLSX = (await import("@e965/xlsx")) as unknown as {
    read(
      data: Uint8Array,
      opts: { type: "buffer" },
    ): {
      SheetNames: string[];
      Sheets: Record<string, unknown>;
    };
    utils: { sheet_to_csv(sheet: unknown): string };
  };
  const book = XLSX.read(bytes, { type: "buffer" });
  const blocks: string[] = [];
  let size = 0;
  // Stop at the cap rather than building every sheet and cutting the answer: a
  // workbook expands to many times its bytes as text, and this runs on the
  // server that also serves the app.
  for (const name of book.SheetNames) {
    if (size >= DOCUMENT_TEXT_MAX) break;
    const sheet = book.Sheets[name];
    const csv = sheet === undefined ? "" : XLSX.utils.sheet_to_csv(sheet);
    const block = `# ${name}\n${csv}`;
    blocks.push(block);
    size += block.length;
  }
  return blocks.join("\n\n");
}

/**
 * **PDF** — the text layer, page by page.
 *
 * `pdfjs-dist`'s legacy build reads in Node with no canvas: what it can give is
 * the text, which is what is wanted. Embedded JavaScript is not evaluated
 * (`isEvalSupported: false`): a document is somebody else's bytes, and a reader
 * that runs its scripts is a door, not a reader.
 */
async function pdfText(
  bytes: Uint8Array,
): Promise<{ text: string; scanned: number[]; cut: boolean }> {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
    getDocument(input: Record<string, unknown>): {
      promise: Promise<{
        numPages: number;
        getPage(n: number): Promise<{
          getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
          cleanup(): void;
        }>;
      }>;
      destroy(): Promise<void>;
    };
  };
  const task = pdfjs.getDocument({
    // A copy: pdfjs transfers the buffer it is handed, and the bytes stay needed
    // by the rasteriser when a page turns out to be a scan.
    data: bytes.slice(),
    isEvalSupported: false,
    useSystemFonts: true,
  });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (err) {
    // A document that never loaded still owns its worker.
    await task.destroy();
    throw err;
  }
  const pages: string[] = [];
  const scanned: number[] = [];
  let cut = false;
  let size = 0;
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      if (size >= DOCUMENT_TEXT_MAX) {
        cut = true;
        break;
      }
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => (typeof item.str === "string" ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      // A page with no text layer is a picture: the dispatcher renders it and
      // asks the model, so a mixed document is not read only for its text pages.
      if (!text) scanned.push(n);
      else {
        pages.push(text);
        size += text.length;
      }
      page.cleanup();
    }
  } finally {
    // The loading task owns the worker and the document; destroying the document
    // alone leaves both behind.
    await task.destroy();
  }
  return { text: pages.join("\n\n"), scanned, cut };
}

/** How many pages of one scanned PDF are handed to the model. */
export const SCANNED_PAGES_MAX = 5;

/**
 * **A scan** — the pages of a PDF with no text layer, as pictures for the model.
 *
 * `pdfium` renders each page to a bitmap and nothing else: the encoder below is
 * the twenty lines a PNG needs, because the model's image part must be a real
 * image and this tree has no image library. The page count is capped: a hundred
 * pages of scan are a hundred model calls, and a run that meets one is told what
 * it got.
 */
async function rasterText(
  bytes: Uint8Array,
  readImage: NonNullable<Parameters<typeof readDocument>[3]>["readImage"] & {},
  had: string,
  scanned: readonly number[],
): Promise<string> {
  const { PDFiumLibrary } = (await import("@hyzyla/pdfium")) as unknown as {
    PDFiumLibrary: {
      init(): Promise<{
        loadDocument(data: Uint8Array): Promise<{
          getPageCount(): number;
          getPage(index: number): {
            render(opts: { scale: number }): Promise<{
              width: number;
              height: number;
              data: Uint8Array;
            }>;
          };
          destroy(): void;
        }>;
        destroy(): void;
      }>;
    };
  };
  const library = await PDFiumLibrary.init();
  let document: Awaited<ReturnType<typeof library.loadDocument>> | null = null;
  try {
    document = await library.loadDocument(bytes);
    const total = document.getPageCount();
    const wanted = scanned.slice(0, SCANNED_PAGES_MAX);
    const said: string[] = [];
    for (const number of wanted) {
      const page = document.getPage(number - 1);
      const render = await page.render({ scale: 1 });
      const read = await readImage({
        type: "image/png",
        data: pngOfBgra(render.width, render.height, render.data),
      });
      said.push("problem" in read ? `page ${number}: ${read.problem}` : read.text);
    }
    // Truncation is said, not paid silently: a run must not conclude that a
    // hundred-page scan is a five-page document.
    if (scanned.length > wanted.length)
      said.push(
        `pages ${wanted[0] ?? 1}-${wanted.at(-1) ?? 0} of ${total} were read as pictures; the rest were not.`,
      );
    return [had, ...said].filter((part) => part.trim()).join("\n\n");
  } finally {
    document?.destroy();
    library.destroy();
  }
}

/** A PNG from a page's BGRA bitmap, which is what the model's image part takes. */
function pngOfBgra(width: number, height: number, data: Uint8Array): Uint8Array {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    const from = y * width * 4;
    for (let x = 0; x < width; x++) {
      const at = from + x * 4;
      raw[row + 1 + x * 4] = data[at + 2] ?? 0;
      raw[row + 2 + x * 4] = data[at + 1] ?? 0;
      raw[row + 3 + x * 4] = data[at] ?? 0;
      raw[row + 4 + x * 4] = 255;
    }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8; // bit depth
  head[9] = 6; // colour type: RGBA
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", head),
      pngChunk("IDAT", inflate(raw)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/** One PNG chunk: length, type, body, CRC — the four fields the format has. */
function pngChunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** Deflate, the compression an IDAT carries. */
function inflate(raw: Buffer): Buffer {
  return deflateSync(raw);
}

/** The CRC-32 a PNG chunk carries. */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * **ODF** — odt, odp and every other OpenDocument file: a zip whose `content.xml`
 * is the document.
 *
 * There is no ODF library here and adding one for a text extraction would be a
 * dependency for what a zip reader and a character walk answer: paragraphs and
 * headings become lines, cells are separated, and the formatting is what is
 * dropped.
 */
async function odfText(bytes: Uint8Array): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const content = zip.file("content.xml");
  if (!content) throw new Error("The document has no content.xml.");
  const xml = await content.async("string");
  const decoded = stripTags(
    xml
      .replace(/<text:(p|h)\b[^>]*>/g, "\n")
      .replace(/<table:table-cell\b[^>]*\/>/g, ", ")
      .replace(/<table:table-cell\b[^>]*>/g, ""),
  )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
  /*
   * Entities can spell markup back -- `&lt;script&gt;` decodes to a tag after
   * the strip above -- so the decoded text is stripped again, and a bracket that
   * begins nothing goes with it. A tag is never rebuilt from a pattern here: the
   * strip walks the characters and copies only what is outside one.
   */
  return stripTags(decoded)
    .replace(/[<>]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The text of an XML document, tag by tag.
 *
 * A character walk rather than a pattern: removing `<...>` with a regular
 * expression is the sanitizer CodeQL refuses (`js/incomplete-multi-character-
 * sanitization`), because a removal can join two halves into a tag. Here a `<`
 * starts a tag, a `>` ends it, and nothing between the two is copied — the
 * answer cannot contain a tag it did not already have.
 */
function stripTags(text: string): string {
  let out = "";
  let inside = false;
  for (const ch of text) {
    if (ch === "<") inside = true;
    else if (ch === ">") inside = false;
    else if (!inside) out += ch;
  }
  return out;
}

/**
 * A text file's characters: UTF-8 when the bytes are UTF-8, and the encoding a
 * spreadsheet or a legacy CSV from a desktop is usually in otherwise.
 *
 * A decoder that guessed wrong would answer replacement characters as though they
 * were the document; the alternative is refusing a file a person can perfectly
 * well read, which is worse here.
 */
function textOf(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** The kind a MIME names, or null when it names none this build reads. */
function kindOfType(type: string): DocumentKind | null {
  if (type === "application/pdf") return "pdf";
  if (type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    return "docx";
  if (type.includes("spreadsheet") || type.includes("ms-excel")) return "sheet";
  if (type === "application/vnd.oasis.opendocument.text") return "odf";
  if (type === "application/vnd.oasis.opendocument.presentation") return "odf";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("text/")) return "text";
  if (type === "application/json" || type === "application/xml") return "text";
  if (type.endsWith("+json") || type.endsWith("+xml")) return "text";
  return null;
}

/** The kind a file's name names, for when the MIME said nothing usable. */
function kindOfName(name: string): DocumentKind | null {
  const file = name.toLowerCase();
  if (file.endsWith(".pdf")) return "pdf";
  if (file.endsWith(".docx")) return "docx";
  if (/\.(xlsx|xlsm|xlsb|xls|ods)$/.test(file)) return "sheet";
  if (/\.(odt|odp|odg|odf)$/.test(file)) return "odf";
  if (/\.(png|jpe?g|gif|webp|bmp|tiff?)$/.test(file)) return "image";
  if (/\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|log|ini|conf|html?)$/.test(file))
    return "text";
  return null;
}

/**
 * The kind a type and a name name, or null when nothing here reads it.
 *
 * The MIME answers first and the name is the fallback, and the order matters: a
 * `.odt` a client labelled `text/plain` is a text file wearing a misleading name,
 * while a `.pdf` that arrived as `application/octet-stream` is still a PDF. Only
 * a type that says nothing (`application/octet-stream`, an empty one, one this
 * build does not know) leaves the name to answer.
 */
export function documentKind(type: string, name: string): DocumentKind | null {
  return kindOfType(type.toLowerCase().trim()) ?? kindOfName(name);
}

/** The image formats the installation's model reads, as the provider names them. */
const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/**
 * What an image's bytes are, as a MIME type the model's own door accepts.
 *
 * A picture's type is the bytes', not the sender's: a WhatsApp pack arrives with
 * every `.jpeg` labelled `application/octet-stream`, and a provider handed a
 * `data:application/octet-stream` part refuses the image outright while the bytes
 * are a valid JPEG (live: Deepseek answered "unsupported image ... webp, png,
 * jpeg, and gif"). The declared type answers when it is one the model reads; the
 * name is the next witness; the magic bytes are the last and strongest one.
 *
 * Null is a picture this installation cannot show the model — a BMP or a TIFF,
 * which the provider would refuse — and the caller says so without spending a
 * call to learn it.
 */
export function imageMediaType(
  type: string,
  name: string,
  bytes: Uint8Array,
): string | null {
  const declared = type.toLowerCase().trim();
  if (IMAGE_MEDIA_TYPES.has(declared)) return declared;
  const named = namedImageType(name);
  if (named) return named;
  return sniffedImageType(bytes);
}

/** The image type a file's extension names, or null. */
function namedImageType(name: string): string | null {
  const file = name.toLowerCase();
  if (/\.jpe?g$/.test(file)) return "image/jpeg";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".gif")) return "image/gif";
  return null;
}

/** The image type the first bytes carry, or null. */
function sniffedImageType(bytes: Uint8Array): string | null {
  const ascii = (from: number, text: string): boolean =>
    [...text].every((ch, i) => (bytes[from + i] ?? -1) === ch.charCodeAt(0));
  if (ascii(0, "\xff\xd8\xff")) return "image/jpeg";
  if (ascii(0, "\x89PNG")) return "image/png";
  if (ascii(0, "GIF8")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}

/**
 * What the document says, or null when this build does not read its format.
 *
 * A reader that throws is a document this call could not read — a PDF the server
 * locked, a zip that is not one — and that is an answer too: `documentText` says
 * so rather than pretending the file is empty.
 */
export async function readDocument(
  bytes: Uint8Array,
  type: string,
  name: string,
  opts: {
    /**
     * The installation's model's eyes, for a PDF whose pages carry no text: a
     * scan is a picture of a document, and a picture is transcribed, not parsed.
     */
    readImage?: (image: {
      type: string;
      data: Uint8Array;
    }) => Promise<{ text: string } | { problem: string }>;
  } = {},
): Promise<DocumentRead | { problem: string } | null> {
  const kind = documentKind(type, name);
  // An image is read by the installation's model (`readImage`), not here: this
  // module turns bytes into text, and a picture has none until somebody looks.
  if (!kind || kind === "image") return null;
  try {
    const text =
      kind === "pdf"
        ? await (async () => {
            const read = await pdfText(bytes);
            // The pages with no text layer are pictures: the model reads those,
            // and the text pages stay text. A document whose text was cut at the
            // bound says so rather than passing a half-read page for whole.
            if (!read.scanned.length || !opts.readImage)
              return read.cut
                ? `${read.text}\n\n(the rest of the document was not read)`
                : read.text;
            return await rasterText(bytes, opts.readImage, read.text, read.scanned);
          })()
        : kind === "docx"
          ? await docxText(bytes)
          : kind === "sheet"
            ? await sheetText(bytes)
            : kind === "odf"
              ? await odfText(bytes)
              : textOf(bytes);
    return { text: text.slice(0, DOCUMENT_TEXT_MAX), kind };
  } catch (err) {
    return {
      problem: `The document could not be read as ${kind}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
