/**
 * What a reading tool answers with: the text of one file (ADR 0027).
 *
 * One file is one answer however it arrived — a document in Files, an attachment
 * of a message. The two surfaces that read a file read it through here, so a
 * format nothing reads and a document that would not open are told apart once.
 */

import { documentKind, imageMediaType, readDocument } from "../../documentText.js";

/** What the installation's model answers when a tool asks it to read an image. */
export type ImageReader = (image: {
  type: string;
  data: Uint8Array;
}) => Promise<{ text: string } | { problem: string }>;

/**
 * The text of one file, as every reading tool answers it (ADR 0027).
 *
 * One file is one answer however it arrived — a document in Files, an attachment
 * of a message: the format readers say what a document says, the model's eyes
 * say what a picture says, and the two failures are told apart (a format nothing
 * reads, and a document that would not open) rather than answered with bytes.
 */
/**
 * The most bytes one tool downloads to read.
 *
 * A document or an attachment is held whole to be read; past this bound the
 * answer is a refusal that says so, rather than a process pressured by one
 * file. 32 MB is far above any document a person puts in Files on purpose.
 */
export const READ_BYTES_MAX = 32 * 1024 * 1024;

export async function readFileText(
  file: { type: string; name: string; bytes: Uint8Array },
  readImage?: ImageReader,
): Promise<{
  text: string | null;
  readable: boolean;
  kind?: string;
  problem?: string;
}> {
  if (documentKind(file.type, file.name) === "image") {
    if (!readImage)
      return {
        text: null,
        readable: false,
        problem: "This installation's agent cannot look at an image.",
      };
    /*
     * The provider is handed the bytes' own type: a WhatsApp pack labels every
     * JPEG `application/octet-stream`, and a `data:application/octet-stream`
     * part is refused as an unsupported image while the bytes are a valid JPEG.
     */
    const type = imageMediaType(file.type, file.name, file.bytes);
    if (!type)
      return {
        text: null,
        readable: false,
        problem: `The image "${file.name}" is not a format the installation's model reads (JPEG, PNG, WebP or GIF).`,
      };
    const read = await readImage({ type, data: file.bytes });
    return "problem" in read
      ? { text: null, readable: false, problem: read.problem }
      : { text: read.text, readable: true, kind: "image" };
  }
  const document = await readDocument(file.bytes, file.type, file.name, { readImage });
  if (document === null) return { text: null, readable: false };
  if ("problem" in document)
    return { text: null, readable: false, problem: document.problem };
  return { text: document.text, readable: true, kind: document.kind };
}
