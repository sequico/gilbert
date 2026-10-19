import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GENERIC_TYPES,
  isInlineImage,
  isInlineSafe,
  isPdfType,
  mediaType,
  typeFromName,
} from "./media.js";

/**
 * The rule that decides what a browser is handed, and what a picture is.
 *
 * The server serves a blob inline on this answer and the client offers "open in
 * a new tab" on it, so the two agree only because there is one of it: the client
 * re-exports `isInlineSafe` rather than answering again. What the tests below
 * pin is the answer itself — a type the pair gets wrong is a file served as an
 * attachment that should have opened, or a document rendered where it must not
 * be — and `IMAGE/PNG`, which the two spellings disagreed about before this.
 */

test("a media type is read without its parameters, and without its case", () => {
  assert.equal(mediaType("text/plain; charset=utf-8"), "text/plain");
  assert.equal(mediaType("  IMAGE/PNG  "), "image/png");
  assert.equal(mediaType(null), "");
  assert.equal(mediaType(undefined), "");
});

test("what a browser may be handed inline, and what it may not", () => {
  for (const type of [
    "image/png",
    "IMAGE/PNG",
    "image/jpeg; charset=binary",
    "video/mp4",
    "audio/mpeg",
    "application/pdf",
    "text/plain",
    "text/calendar",
    "text/vcard",
  ]) {
    assert.equal(isInlineSafe(type), true, `${type} should be served inline`);
  }

  for (const type of [
    "image/svg+xml",
    "text/html",
    "application/xhtml+xml",
    "application/json",
    "text/xml",
    "application/javascript",
    "application/octet-stream",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isInlineSafe(type), false, `${type} should not be served inline`);
  }
});

test("a picture is an image that is not an SVG", () => {
  assert.equal(isInlineImage("image/webp"), true);
  assert.equal(isInlineImage("image/svg+xml"), false);
  assert.equal(isInlineImage("application/pdf"), false);
  assert.equal(isInlineImage(null), false);

  // The picture rule is a part of the inline rule, not a second opinion on it.
  for (const type of ["image/png", "image/svg+xml", "text/plain", "video/mp4"]) {
    if (isInlineImage(type)) assert.equal(isInlineSafe(type), true);
  }
});

test("the types that say nothing about a file are a closed set", () => {
  assert.equal(GENERIC_TYPES.has(""), true);
  assert.equal(GENERIC_TYPES.has("application/octet-stream"), true);
  assert.equal(GENERIC_TYPES.has("application/pdf"), false);
  // Lower case only: every reader asks about `mediaType(...)`, never a raw header.
  assert.equal(GENERIC_TYPES.has("APPLICATION/OCTET-STREAM"), false);
});

test("a name answers for a type that says nothing, and a PDF is a PDF in either spelling", () => {
  // The booking-confirmation case: the store said octet-stream, the name said
  // .pdf, and octet-stream is never rendered whatever the file is.
  assert.equal(typeFromName("279726936 booking.pdf"), "application/pdf");
  assert.equal(typeFromName("SHOT.PNG"), "image/png");
  assert.equal(typeFromName("photo.jpeg"), "image/jpeg");
  assert.equal(typeFromName("report"), null);
  assert.equal(typeFromName(null), null);

  assert.equal(isPdfType("application/pdf"), true);
  assert.equal(isPdfType("application/x-pdf"), true);
  assert.equal(isPdfType("application/acrobat"), true);
  assert.equal(isPdfType("application/octet-stream"), false);
  assert.equal(isInlineSafe("application/x-pdf"), true);
});
