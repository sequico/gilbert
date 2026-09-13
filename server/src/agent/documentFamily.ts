/**
 * The document family's engine (ADR 0003 resolution 11): page work on a PDF,
 * the text a document carries of its own, and the rasteriser.
 *
 * `documents.ts` is the catalogue the model and the rule editor read; this is
 * what runs the work it names, **in memory**: bytes come in from the group's
 * own Files, the work happens in the process, and the result is bytes or text
 * the caller writes back or hands to the run. The libraries are pure
 * JavaScript or WASM with no native build and no canvas — `pdf-lib` for a
 * PDF's pages, `pdfjs-dist` for its own text layer, `mammoth` for a `.docx`,
 * and `@hyzyla/pdfium` (WASM) to render a page to a bitmap — because the
 * deployment is immutable and disposable: no writable filesystem, no scratch
 * directory, no child process.
 *
 * Reading spans the two halves. A page whose own text layer is empty is the
 * page somebody scanned, and there is no OCR engine here on purpose: those
 * pages are rendered and handed to the run's call as images, and the model
 * reads them (ADR 0003: a page that is only pixels is read by the model,
 * because it has eyes). Nothing here writes a `.docx` either, for the reason
 * the ADR gives: producing one is a job for a person's word processor.
 */

import zlib from "node:zlib";
import * as XLSX from "@e965/xlsx";
import { PDFiumLibrary, type PDFiumPage as PdfPage } from "@hyzyla/pdfium";
import mammoth from "mammoth";
import { PDFDocument } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { errorMessage } from "./audit.js";

/**
 * The four kinds this family reads.
 *
 * `sheet` is one kind for `.xls` and `.xlsx` alike: the reader sniffs which
 * container it was handed, and what a run needs to know is that it is a
 * workbook, not which decade it was written in. `text` is everything a person
 * could open in an editor — a `.csv`, a `.txt`, and the other plain-text types
 * `documentKindOf` names.
 */
export type DocumentKind = "pdf" | "docx" | "sheet" | "text";

/** What went wrong, in a word the trail can name. */
export type DocumentErrorCode =
  /** A library refused the bytes. */
  | "unreadable_document"
  /** The file is neither a PDF nor a `.docx`. */
  | "unsupported_type"
  /** The page range names no page of this document. */
  | "invalid_range"
  /** The document carries no pages at all. */
  | "no_pages"
  /** The file is larger than one run reads. */
  | "document_too_large"
  /** One action would write more pages than it may. */
  | "document_too_many_pages"
  /** Nothing to work on: no file named, and none woke the run. */
  | "no_file"
  /** The group's Files hold no file at that path. */
  | "no_such_file";

/**
 * A refusal of the document family.
 *
 * Every one carries its own code, and the message ends with it: a run's audit
 * line is the message, so a file the deployment cannot read is refused by name
 * rather than skipped (ADR 0003: an action the deployment cannot do is refused,
 * never dropped).
 */
export class DocumentError extends Error {
  constructor(
    public readonly code: DocumentErrorCode,
    message: string,
  ) {
    super(`${message} (${code})`);
    this.name = "DocumentError";
  }
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/** What a document's own text layer says. */
export interface DocumentRead {
  kind: DocumentKind;
  /**
   * The pages the document carries. A `.docx` is one body of text until
   * something lays it out, which nothing here does, so it counts as one.
   */
  pages: number;
  /** The text those pages carry, page by page. */
  text: string;
  /**
   * The 1-based pages that carry no text layer at all.
   *
   * These are the scanned ones: there is nothing to extract, so they are the
   * pages a model reads from an image.
   */
  pixelPages: number[];
  /**
   * How many of the document's pages this reading looked at, counted from the
   * first: a PDF's text layer is read page by page up to the bound, and a
   * `.docx` is one body of text read whole.
   */
  looked: number;
  /**
   * Whether the reading stopped before the end of a text file or a workbook.
   *
   * A PDF and a `.docx` are bounded by pages, which `looked` and the caller's
   * `unreadPages` already state. Text has no pages of its own, so the ceiling
   * that stopped it is named here rather than left to be inferred: a run handed
   * the beginning of a file has to be told that is what it got (ADR 0003).
   */
  truncated: boolean;
}

/** One page, rendered in the process, as the model is handed it. */
export interface PageImage {
  /** 1-based, as a person counts the pages. */
  page: number;
  png: Uint8Array;
}

/** What a run's call carries for one document: what it says, and what it looks like. */
export interface DocumentContent {
  read: DocumentRead;
  /** At most `maxPages` of the pages with no text layer, rendered. */
  images: PageImage[];
  /** How many of those pages the bound left out. */
  omitted: number;
  /**
   * The pages of the document past the ones this reading looked at: nothing of
   * them was read here at all.
   *
   * A separate fact from `omitted`, which counts the pages with no text layer
   * the bound left out of the reading. A document longer than the bound has
   * pages whose own text layer was never opened, and a run handed the first
   * pages of such a document without being told so would take them for the
   * whole of it (ADR 0003).
   */
  unreadPages: number;
}

/**
 * Which of the two kinds a file is, from its name or its media type, or null
 * when it is neither.
 *
 * The name is the reliable signal in Stalwart's Files — a type is often absent
 * and sometimes somebody else's guess — so the extension decides first and the
 * media type is the fallback.
 */
export function documentKindOf(name: string, type?: string): DocumentKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) return "sheet";
  if (TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension))) return "text";
  const media = ((type ?? "").toLowerCase().split(";")[0] ?? "").trim();
  if (media === "application/pdf") return "pdf";
  if (media === "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    return "docx";
  if (media === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    return "sheet";
  // The name is decided first, because `application/vnd.ms-excel` is also what
  // a server says about a `.csv` it does not know — a type that is the only
  // signal there is falls back to here.
  if (media === "application/vnd.ms-excel") return "sheet";
  if (media.startsWith("text/")) return "text";
  return null;
}

/**
 * The extensions whose content is text a person could open in an editor.
 *
 * Named rather than sniffed: a file's first bytes say little about whether
 * somebody meant it as prose, and a wrong guess here hands a run a binary it
 * will read as characters. Everything else that is text carries a `text/*`
 * type, which `documentKindOf` falls back to.
 */
const TEXT_EXTENSIONS = [
  ".txt",
  ".csv",
  ".tsv",
  ".md",
  ".json",
  ".log",
  ".xml",
  ".yaml",
  ".yml",
  ".ini",
  ".conf",
];

/**
 * The shortest text a page may carry and still be a text layer.
 *
 * Below it the page is a stamp, a watermark or a page number: what a person
 * sees on that page is pixels, so the model is handed the page rather than the
 * fragment (ADR 0003).
 */
const MIN_TEXT_LAYER_CHARS = 12;

/**
 * The most text one reading carries, in characters.
 *
 * A file's own bytes are already bounded before this (`AGENT_DOCUMENT_BYTES_MAX`),
 * and that bound is what a PDF's text layer and a `.docx` body live inside. A
 * text file or a workbook is different in kind: its whole content *is* text, so
 * the byte ceiling alone would hand a run megabytes of characters — an input
 * bill with no ceiling of its own. This is that ceiling, and a reading that
 * reaches it says so rather than presenting its beginning as the whole of it
 * (ADR 0003).
 */
export const DOCUMENT_TEXT_MAX = 200_000;

/**
 * Cut a reading at the character ceiling, and say whether it was cut.
 *
 * One rule for text files and workbooks alike: a file is read from its start,
 * and what a run is handed is the beginning of it rather than a selection
 * nobody asked for.
 */
function cutAtCeiling(text: string): { text: string; truncated: boolean } {
  if (text.length <= DOCUMENT_TEXT_MAX) return { text, truncated: false };
  return { text: text.slice(0, DOCUMENT_TEXT_MAX), truncated: true };
}

/** Read a document's own text: a PDF's text layer, or the text of a `.docx`. */
export async function readDocument(
  bytes: Uint8Array,
  kind: DocumentKind,
  /** How many pages this run may work with, as the installation set it. */
  maxPages: number,
): Promise<DocumentRead> {
  if (kind === "docx") {
    return {
      kind,
      pages: 1,
      text: await docxText(bytes),
      pixelPages: [],
      looked: 1,
      truncated: false,
    };
  }
  if (kind === "text") {
    const cut = cutAtCeiling(textFile(bytes));
    return {
      kind,
      pages: 1,
      text: cut.text,
      pixelPages: [],
      looked: 1,
      truncated: cut.truncated,
    };
  }
  if (kind === "sheet") return sheetRead(bytes, maxPages);
  const { pages, texts, last } = await pdfPageTexts(bytes, maxPages);
  const pixelPages: number[] = [];
  texts.forEach((text, index) => {
    if (!text.trim()) pixelPages.push(index + 1);
  });
  return {
    kind,
    pages,
    text: texts
      .map((text) => text.trim())
      .filter(Boolean)
      .join("\n\n"),
    pixelPages,
    looked: last,
    truncated: false,
  };
}

/**
 * A document as the run's call carries it: its text, and the pages with no
 * text layer rendered as images, at most `maxPages` of them.
 *
 * The bound is the caller's — one knob per installation — and what it left out
 * is reported rather than dropped, so a run is never told a half of a document
 * as though it were the whole of it (ADR 0003: how many pages one run may hand
 * over is bounded rather than left to the document's size).
 *
 * `opts.vision` is what the installation's model can read: a deployment without
 * vision is handed no page at all, so no page is rendered for it rather than
 * rendered and then dropped (ADR 0003).
 */
export async function documentContent(
  bytes: Uint8Array,
  kind: DocumentKind,
  maxPages: number,
  opts: { vision?: boolean } = {},
): Promise<DocumentContent> {
  const vision = opts.vision !== false;
  const bound = Number.isFinite(maxPages) ? Math.max(0, Math.floor(maxPages)) : 0;
  const read = await readDocument(bytes, kind, bound);
  const unreadPages = Math.max(0, read.pages - read.looked);
  if (read.kind !== "pdf" || !read.pixelPages.length) {
    return { read, images: [], omitted: 0, unreadPages };
  }
  const wanted = read.pixelPages.slice(0, bound);
  return {
    read,
    images: vision ? await renderPages(bytes, wanted) : [],
    omitted: read.pixelPages.length - wanted.length,
    unreadPages,
  };
}

/** A PDF's own text layer, per page, through `pdfjs-dist`. */
async function pdfPageTexts(
  bytes: Uint8Array,
  /** How many pages to read: a bound the caller sets, never the file's size. */
  maxPages: number,
): Promise<{ pages: number; texts: string[]; last: number }> {
  // `pdfjs` takes ownership of the bytes it is handed, and the same file is
  // read again to render a page, so it is given a copy of its own.
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    // No font is fetched from anywhere: this runs under the same strict
    // content policy as the rest of the installation.
    disableFontFace: true,
    useSystemFonts: true,
  });
  try {
    const document = await task.promise;
    const texts: string[] = [];
    // A bound of zero means zero, the same as it does for the images below: a
    // deployment or installation that asks for no pages must get none, not
    // page one's text read and billed anyway.
    const last = Math.min(document.numPages, Math.max(0, Math.floor(maxPages)));
    for (let page = 1; page <= last; page++) {
      const content = await (await document.getPage(page)).getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("");
      // A page whose only text is a stamp, a watermark or a page number has no
      // text layer to read: what a person sees on it is pixels, and the model
      // gets the page rather than the fragment (ADR 0003).
      texts.push(text.trim().length < MIN_TEXT_LAYER_CHARS ? "" : text);
    }
    return { pages: document.numPages, texts, last };
  } catch (err) {
    throw unreadable("this PDF", err);
  } finally {
    // The worker behind the task is not the caller's to leave running.
    await task.destroy().catch(() => undefined);
  }
}

/** The text of a `.docx`, through `mammoth`. */
async function docxText(bytes: Uint8Array): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return result.value.trim();
  } catch (err) {
    throw unreadable("this .docx", err);
  }
}

/**
 * A text file's own bytes, as text.
 *
 * Decoded as UTF-8 with a byte-order mark stripped, and otherwise untouched: a
 * `.csv` is something a person wrote, and a run reads it as it stands. No
 * delimiter is parsed and no column is named — a reader that guessed at a
 * dialect would invent structure the file may not have, and a model reads a
 * table as well as a table parser does.
 */
function textFile(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8").decode(bytes);
  return (text.startsWith("\uFEFF") ? text.slice(1) : text).trim();
}

/**
 * A workbook's sheets, as text: one block per sheet, a row to a line, and a
 * cell separated from the next by a tab.
 *
 * **One sheet counts as one page.** That is what makes a run's page bound mean
 * something here: the first sheets are read whole and the rest are named as
 * unread by `looked` against `pages`, so a workbook longer than the bound is
 * never handed over as though it were the whole of it (ADR 0003). Cells are
 * read as the text the file stores — a number stays a number, a date is the
 * date it says, a formula's cached value is what is read — and nothing here
 * evaluates or writes anything.
 */
function sheetRead(bytes: Uint8Array, maxPages: number): DocumentRead {
  let book: XLSX.WorkBook;
  try {
    book = XLSX.read(Buffer.from(bytes), { type: "buffer", cellDates: true });
  } catch (err) {
    throw unreadable("this spreadsheet", err);
  }
  const names = book.SheetNames ?? [];
  const last = Math.min(names.length, Math.max(0, Math.floor(maxPages)));
  const blocks: string[] = [];
  for (const name of names.slice(0, last)) {
    const sheet = book.Sheets[name];
    const rows = sheet
      ? XLSX.utils.sheet_to_json<unknown[]>(sheet, {
          header: 1,
          raw: true,
          blankrows: false,
        })
      : [];
    blocks.push(
      [`# ${name}`, ...rows.map((row) => row.map(sheetCell).join("\t"))].join("\n"),
    );
  }
  const cut = cutAtCeiling(blocks.join("\n\n"));
  return {
    kind: "sheet",
    pages: names.length,
    text: cut.text,
    pixelPages: [],
    looked: last,
    truncated: cut.truncated,
  };
}

/** One cell, as the text a run reads: what the file stores, never a guess. */
function sheetCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

/* ------------------------------------------------------------------ */
/* The rasteriser                                                      */
/* ------------------------------------------------------------------ */

/**
 * How large a page is rendered: twice its own size, which is 144 dpi for the
 * 72-dpi units a PDF measures in — enough for a model to read the text of a
 * page from the image.
 */
const PAGE_RENDER_SCALE = 2;

/**
 * The WASM engine, loaded once for the process and kept.
 *
 * The engine is a library handle rather than per-document state, and loading
 * it costs a WASM instantiation the process should pay for once. A load that
 * failed is not remembered: the next call tries again rather than reporting a
 * startup failure for the rest of the process's life.
 */
let engine: Promise<PDFiumLibrary> | null = null;

function pdfEngine(): Promise<PDFiumLibrary> {
  engine ??= PDFiumLibrary.init().catch((err: unknown) => {
    engine = null;
    throw unreadable("the PDF engine", err);
  });
  return engine;
}

/**
 * How many pixels one rendered page may have, at most.
 *
 * The byte ceiling on the file bounds what arrives; this bounds what it becomes.
 * A page is held as a bitmap while it is rendered, ten times over in the worst
 * case (the page, the filtered scanlines, the deflated bytes, the copy the
 * engine keeps, the base64 of the call), so an A0 sheet at twice its own size —
 * 4768 by 6741 pixels, about 128 MB of pixels — is more than a process serving
 * every account on the installation can hold for one page of one file. Four
 * thousand pixels a side is about 64 MB of pixels and still more than a model
 * reads: past it the page is rendered **smaller**, which is the direction that
 * keeps the words legible where refusing would keep nothing.
 */
const PAGE_PIXELS_MAX = 4000 * 4000;

/**
 * Pages of a PDF rendered to PNG images, in the order asked for.
 *
 * PDFium renders to a bitmap in the process and offers nothing else: no
 * canvas, no native image library, no scratch file — so the PNG is encoded
 * here from the bytes the engine hands back.
 */
export async function renderPages(
  bytes: Uint8Array,
  pages: ReadonlyArray<number>,
): Promise<PageImage[]> {
  if (!pages.length) return [];
  const library = await pdfEngine();
  const document = await library.loadDocument(bytes).catch((err: unknown) => {
    throw unreadable("this PDF", err);
  });
  try {
    const out: PageImage[] = [];
    for (const page of pages) {
      const sheet = document.getPage(page - 1);
      const rendered = await sheet.render({ scale: fitScale(sheet, page) });
      out.push({
        page,
        png: await pngFromRgba(rendered.data, rendered.width, rendered.height),
      });
    }
    return out;
  } catch (err) {
    throw unreadable(`page ${pages.join(", ")} of this PDF`, err);
  } finally {
    document.destroy();
  }
}

function unreadable(what: string, err: unknown): DocumentError {
  if (err instanceof DocumentError) return err;
  return new DocumentError(
    "unreadable_document",
    `${what} cannot be read: ${errorMessage(err)}`,
  );
}

/* ------------------------------------------------------------------ */
/* A page as a PNG                                                     */
/* ------------------------------------------------------------------ */

/** The eight bytes every PNG starts with. */
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A rendered page as a PNG: four bytes a pixel, red first, as the engine hands
 * them over.
 *
 * The engine's own options declare a `BGRA` bitmap, and what it returns from
 * `render` is RGBA — read off a red page rather than off its declarations, which
 * is why the channels are copied through and not swapped: a swap here paints
 * every scan its own byte order, and a model asked to read a page is entitled to
 * the page's colours. (The probe that says so is the fixture in `llm.test.ts`:
 * an opaque red page that comes back red, where a swap makes it blue.)
 *
 * A PNG is a signature, a header, one deflated run of filtered scanlines and a
 * CRC a chunk — `node:zlib` covers the deflating and the CRC, and PNG's filter
 * 0 (no prediction) keeps the rest to a copy per row. Nothing here touches the
 * filesystem, which is what this deployment has none of.
 */
async function pngFromRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const stride = width * 4;
  const rows = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    rows[row] = 0;
    for (let x = 0; x < width; x++) {
      const from = y * stride + x * 4;
      const to = row + 1 + x * 4;
      rows[to] = rgba[from] ?? 0;
      rows[to + 1] = rgba[from + 1] ?? 0;
      rows[to + 2] = rgba[from + 2] ?? 0;
      rows[to + 3] = rgba[from + 3] ?? 0;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // eight bits a channel
  header[9] = 6; // red, green, blue, alpha
  // The deflating is asynchronous on purpose: this process serves every account
  // on the installation, and a synchronous deflate of a page-sized buffer
  // stops all of it for as long as the compressing takes.
  return concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", await deflate(rows)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

/**
 * The scale a page is rendered at, brought down until its bitmap fits the
 * ceiling: the size a sheet wants, then the largest scale that keeps it inside.
 */
function fitScale(sheet: PdfPage, page: number): number {
  let size: { originalWidth: number; originalHeight: number };
  try {
    size = sheet.getOriginalSize();
  } catch (err) {
    throw unreadable(`page ${page} of this PDF`, err);
  }
  const pixels =
    size.originalWidth * size.originalHeight * PAGE_RENDER_SCALE * PAGE_RENDER_SCALE;
  if (!Number.isFinite(pixels) || pixels <= PAGE_PIXELS_MAX) return PAGE_RENDER_SCALE;
  return PAGE_RENDER_SCALE * Math.sqrt(PAGE_PIXELS_MAX / pixels);
}

/** `zlib.deflate`, as a promise: the async half of the one encoder. */
function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zlib.deflate(bytes, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

/** One PNG chunk: its length, its type and data, and the CRC over both. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  new DataView(chunk.buffer).setUint32(0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  new DataView(chunk.buffer).setUint32(
    8 + data.length,
    zlib.crc32(chunk.subarray(4, 8 + data.length)),
  );
  return chunk;
}

function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Page work                                                           */
/* ------------------------------------------------------------------ */

/** A PDF, read; a file the engine cannot read is refused by name. */
async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes);
  } catch (err) {
    throw unreadable("this PDF", err);
  }
}

/**
 * How many pages a PDF carries, read from its own page tree.
 *
 * Materialising the pages is the expensive half of the page work, so a caller
 * with a ceiling on how many pages it will write asks this first and refuses
 * the document without copying a page of it.
 */
export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  return (await loadPdf(bytes)).getPageCount();
}

/** Every page of a PDF, as a PDF of its own, in page order. */
export async function splitPdf(bytes: Uint8Array): Promise<Uint8Array[]> {
  const source = await loadPdf(bytes);
  const pages = source.getPageCount();
  if (!pages) throw noPages();
  const out: Uint8Array[] = [];
  for (let page = 0; page < pages; page++) out.push(await copyPages(source, [page]));
  return out;
}

/** The pages a range names out of a PDF, cut into one PDF of their own. */
export async function extractPages(
  bytes: Uint8Array,
  range: string,
): Promise<{ pages: number[]; bytes: Uint8Array }> {
  const source = await loadPdf(bytes);
  const pages = source.getPageCount();
  if (!pages) throw noPages();
  const wanted = parsePageRange(range, pages);
  return {
    pages: wanted,
    bytes: await copyPages(
      source,
      wanted.map((page) => page - 1),
    ),
  };
}

/** Several PDFs joined in the order given, as one PDF. */
export async function mergePdfs(sources: ReadonlyArray<Uint8Array>): Promise<Uint8Array> {
  if (!sources.length)
    throw new DocumentError("no_file", "there is nothing to merge: no PDF was named");
  const merged = await PDFDocument.create();
  for (const bytes of sources) {
    const source = await loadPdf(bytes);
    const pages = await merged.copyPages(source, source.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  if (!merged.getPageCount()) throw noPages();
  return merged.save();
}

async function copyPages(
  source: PDFDocument,
  indices: ReadonlyArray<number>,
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const pages = await out.copyPages(source, [...indices]);
  for (const page of pages) out.addPage(page);
  if (!out.getPageCount()) throw noPages();
  return out.save();
}

function noPages(): DocumentError {
  return new DocumentError("no_pages", "this PDF carries no pages");
}

/**
 * The pages a range names: 1-based, in the order written, each once — `"2-4,7"`
 * is pages 2, 3, 4 and 7.
 *
 * A range that names no page of the document is refused rather than clamped or
 * read as "all of it": a page number a person did not mean is a page of the
 * wrong document out the other end.
 */
export function parsePageRange(spec: string, pageCount: number): number[] {
  const wanted: number[] = [];
  for (const token of spec.split(",")) {
    const text = token.trim();
    if (!text) continue;
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(text);
    if (!match) throw invalidRange(spec, pageCount);
    const from = Number.parseInt(match[1] ?? "", 10);
    const to = match[2] === undefined ? from : Number.parseInt(match[2], 10);
    if (from < 1 || to > pageCount || from > to) throw invalidRange(spec, pageCount);
    for (let page = from; page <= to; page++) {
      if (!wanted.includes(page)) wanted.push(page);
    }
  }
  if (!wanted.length) throw invalidRange(spec, pageCount);
  return wanted;
}

function invalidRange(spec: string, pageCount: number): DocumentError {
  return new DocumentError(
    "invalid_range",
    `"${spec}" is not a range of this document: it carries ${pageCount} pages, counted from 1`,
  );
}
