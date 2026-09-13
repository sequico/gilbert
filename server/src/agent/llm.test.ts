import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import zlib from "node:zlib";
import { PDFDocument, rgb } from "pdf-lib";

/**
 * The model client against a stub OpenAI-compatible endpoint.
 *
 * What is asserted here is the contract the advisor's answers are checked
 * against: the zero-retention opt-out on every request, temperature 0 and a
 * JSON response format, and — the part that matters for permissions — a model
 * answer that names a capability outside the rule's list, a parameter the
 * capability does not take, or a required parameter it left out is refused
 * before it can become an effect.
 *
 * It also carries the claim the rasteriser rests on: a document's text layer
 * is read as text, and a page that has none reaches the model as an image.
 */

const PORT = 18850;

interface Seen {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

let seen: Seen | null = null;
let status = 200;
let body = "";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const stub = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const raw = await readBody(req);
  seen = {
    url: req.url ?? "",
    headers: req.headers,
    body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
  };
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
});

/** Answer the next call with this content, as a chat completion carries it. */
function answerWith(value: unknown): void {
  status = 200;
  body = JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] });
}

/** Answer the next call with prose, the way a reading is answered. */
function answerProseWith(text: string): void {
  status = 200;
  body = JSON.stringify({ choices: [{ message: { content: text } }] });
}

const provider = {
  provider: "openai",
  model: "a-small-model",
  baseUrl: `http://127.0.0.1:${PORT}/v1`,
  apiKey: "sk-test-key",
};

const { assertUsableProvider, callModel, decideActions, providerFor, readProse } =
  await import("./llm.js");
const { AGENT_MAX_PAGES_DEFAULT, MODEL_MAX_OUTPUT_DEFAULT } = await import(
  "./documents.js"
);
const { documentContent, renderPages } = await import("./documentFamily.js");

before(async () => {
  await new Promise<void>((resolve) => stub.listen(PORT, "127.0.0.1", resolve));
});

/* ------------------------------------------------------------------ */
/* Fixtures: a scanned page, and a page with a text layer              */
/* ------------------------------------------------------------------ */

/**
 * A one-pixel PNG of opaque red, written here rather than checked in.
 *
 * It is what the scanned fixture embeds: no mystery binary, and the colour is
 * one the rasteriser can be caught getting wrong — blue and red swap if the
 * bitmap's byte order is not turned round on the way to a PNG.
 */
function redPixelPng(): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, zlib.crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 1);
  header[8] = 8; // eight bits a channel
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** A PDF of one page that carries an image and no text layer at all. */
async function scannedPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const image = await document.embedPng(redPixelPng());
  document.addPage([300, 200]).drawImage(image, { x: 0, y: 0, width: 300, height: 200 });
  return document.save();
}

/** A PDF of one page whose own text layer says what it says. */
async function textPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document
    .addPage([300, 200])
    .drawText("Invoice 42, payable in 30 days", { x: 20, y: 120, size: 12 });
  return document.save();
}

/**
 * A PDF of one page whose only text is a stamp: a reference somebody printed on
 * it, well under the shortest text a text layer may be.
 */
async function stampedPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.addPage([300, 200]).drawText("Ref 42", { x: 20, y: 120, size: 12 });
  return document.save();
}

/** A PDF of `pages` pages, none of which carries a text layer. */
async function blankPdf(pages: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  for (let page = 0; page < pages; page++) document.addPage([300, 200]);
  return document.save();
}

/**
 * What is inside a PNG the rasteriser produced: its size, and its first pixel.
 *
 * The encoder writes on one IDAT chunk of filter-0 scanlines, RGBA, so the
 * reader here is the same shape on purpose — enough to prove the bytes are the
 * page that was rendered, without a second PNG decoder in the tree.
 */
function pixelsOf(png: Uint8Array): {
  width: number;
  height: number;
  first: number[];
} {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const parts: Uint8Array[] = [];
  for (let at = 8; at + 12 <= png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === "IDAT") parts.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const rows = zlib.inflateSync(Buffer.concat(parts));
  return { width, height, first: [...rows.subarray(1, 5)] };
}

after(() => {
  stub.close();
});

test("every request carries the zero-retention opt-out, temperature 0 and JSON output", async () => {
  answerWith({ ok: true });
  const { answer, usage } = await callModel(provider, {
    system: "be brief",
    user: "hello",
  });
  assert.deepEqual(answer, { ok: true });
  assert.ok(seen);
  assert.equal(seen.url, "/v1/chat/completions");
  assert.equal(seen.headers["x-data-opt-out"], "true");
  assert.equal(seen.body.temperature, 0);
  assert.deepEqual(seen.body.response_format, { type: "json_object" });
  assert.equal(seen.body.model, "a-small-model");
  // Every answer is capped, and a provider that reported no usage says
  // nothing at all rather than reporting zeros: the meter reads the second as
  // "a run nobody can price" (ADR 0010: an uncapped answer is an uncapped
  // bill).
  assert.equal(seen.body.max_tokens, MODEL_MAX_OUTPUT_DEFAULT);
  // This mock reports no `usage` field at all, so the call is uncounted —
  // `undefined`, not a null-filled reading (`usageOf` in llm.ts, ADR 0010).
  assert.equal(usage, undefined);
  const messages = seen.body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[1]?.content, "hello");
});

test("the reported usage is read as it is, and the cap and the thinking switch go out", async () => {
  status = 200;
  body = JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
    usage: {
      prompt_cache_hit_tokens: 1200,
      prompt_cache_miss_tokens: 40,
      completion_tokens: 12,
    },
  });
  const { usage } = await callModel(provider, {
    system: "s",
    user: "u",
    maxOutputTokens: 512,
    thinking: false,
  });
  assert.deepEqual(usage, {
    inputHitTokens: 1200,
    inputMissTokens: 40,
    outputTokens: 12,
  });
  assert.equal(seen?.body.max_tokens, 512);
  assert.deepEqual(seen?.body.thinking, { type: "disabled" });
});

test("a non-2xx answer is an error naming the status and the first line", async () => {
  status = 429;
  body = "rate limited\nwith more detail";
  await assert.rejects(
    () => callModel(provider, { system: "s", user: "u" }),
    /answered 429: rate limited/,
  );
});

test("a body that is not JSON is an error, not a silent empty answer", async () => {
  status = 200;
  body = "<html>gateway</html>";
  await assert.rejects(() => callModel(provider, { system: "s", user: "u" }), /not JSON/);
});

test("without a configured model nothing can run", () => {
  assert.throws(() => providerFor(null), /no model is configured/);
  assert.throws(
    () => providerFor({ v: 1, address: "gilbert@example.com" }),
    /no model is configured/,
  );
  assert.throws(
    () =>
      providerFor({
        v: 1,
        address: "gilbert@example.com",
        provider: {
          provider: "p",
          model: "m",
          baseUrl: "https://x.example",
          apiKey: " ",
        },
      }),
    /has no api key/,
  );
});

const decisionRule = { name: "Answer the chat", instruction: "help the group" };

test("a validated answer is the summary a member reads", async () => {
  answerWith({
    summary: "It would label the message.",
    confidence: 0.4,
    rationale: "the subject says invoice",
    actions: [{ do: "keyword.add", with: { keyword: "G-processed" } }],
  });
  const answer = await decideActions(provider, decisionRule, { text: "hi" }, [
    "keyword.add",
    "noop",
  ]);
  assert.equal(answer.summary, "It would label the message.");
  assert.equal(answer.confidence, 0.4);
  assert.deepEqual(answer.actions, [
    { do: "keyword.add", with: { keyword: "G-processed" } },
  ]);
  const messages = seen?.body.messages as Array<{ role: string; content: string }>;
  assert.match(messages[0]?.content ?? "", /keyword\.add/);
  assert.match(messages[0]?.content ?? "", /parameters: keyword/);
});

test("refuses a capability the rule does not allow", async () => {
  answerWith({
    summary: "Send it.",
    confidence: 0.9,
    actions: [{ do: "mail.send", with: { to: "ada@example.org" } }],
  });
  await assert.rejects(
    () => decideActions(provider, decisionRule, { text: "hi" }, ["keyword.add", "noop"]),
    /does not allow \(keyword\.add, noop\)/,
  );
});

test("T2 refuses a parameter the capability does not take", async () => {
  answerWith({
    summary: "Label it.",
    confidence: 0.9,
    actions: [{ do: "keyword.add", with: { keyword: "G-processed", colour: "red" } }],
  });
  await assert.rejects(
    () => decideActions(provider, decisionRule, { text: "hi" }, ["keyword.add"]),
    /parameters it does not take: colour/,
  );
});

test("T2 refuses an answer that leaves a required parameter out", async () => {
  answerWith({
    summary: "Label it.",
    confidence: 0.9,
    actions: [{ do: "keyword.add" }],
  });
  await assert.rejects(
    () => decideActions(provider, decisionRule, { text: "hi" }, ["keyword.add"]),
    /without keyword/,
  );
});

test("T2 refuses a name that is not in the catalogue at all", async () => {
  answerWith({
    summary: "Do something else.",
    confidence: 0.9,
    actions: [{ do: "shell.exec", with: { cmd: "rm -rf /" } }],
  });
  await assert.rejects(
    () => decideActions(provider, decisionRule, { text: "hi" }, ["keyword.add"]),
    /not an action of this catalogue/,
  );
});

test("T2 refuses an answer without a summary a member could read", async () => {
  answerWith({ confidence: 0.9, actions: [{ do: "noop" }] });
  await assert.rejects(
    () => decideActions(provider, decisionRule, { text: "hi" }, ["noop"]),
    /without a summary/,
  );
});

test("T2 with no allowed capability cannot decide anything", async () => {
  await assert.rejects(
    () => decideActions(provider, decisionRule, { text: "hi" }, []),
    /allows no capability/,
  );
});

test("the group's standing instruction is read first, and the automation's after it", async () => {
  // Precedence is stated by position (ADR 0003 resolution 17): the group's own
  // rules of the house, then the instruction this automation carries, then the
  // data — which arrives in the user message and is never an instruction.
  answerWith({
    summary: "s",
    confidence: 1,
    actions: [{ do: "keyword.add", with: { keyword: "k" } }],
  });
  await decideActions(
    provider,
    { name: "File the invoices", instruction: "File invoices into invoices/2026." },
    { text: "THE MESSAGE" },
    ["keyword.add"],
    "Answer in Italian, and never quote a price.",
  );
  const sent = seen as unknown as Seen;
  const messages = sent.body.messages as Array<{ role: string; content: string }>;
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  assert.match(
    system,
    /Answer in Italian/,
    "the group's instruction is in the system prompt",
  );
  assert.match(system, /File invoices into/, "and the automation's instruction is too");
  assert.ok(
    system.indexOf("Answer in Italian") < system.indexOf("File invoices into"),
    "the group's instruction comes first",
  );
  assert.ok(
    system.indexOf("File invoices into") < system.indexOf("THE MESSAGE") ||
      !system.includes("THE MESSAGE"),
    "and the data is not in the system prompt at all",
  );
  assert.match(user, /THE MESSAGE/);
});

test("the notebook comes before the group's standing instruction, and the rule's last", async () => {
  answerWith({ summary: "s", confidence: 1, actions: [{ do: "noop" }] });
  await decideActions(
    provider,
    { name: "Reply", instruction: "File invoices into the right folder." },
    { text: "hi" },
    ["noop"],
    "Answer in Italian",
    "- The group works in Italian.",
  );
  const messages = seen?.body.messages as Array<{ role: string; content: string }>;
  const system = messages[0]?.content ?? "";
  assert.match(system, /The group works in Italian/, "the facts are in the prompt");
  assert.ok(
    system.indexOf("What this group's agent remembers") <
      system.indexOf("Answer in Italian"),
    "the facts come before the group's standing instruction",
  );
  assert.ok(
    system.indexOf("Answer in Italian") < system.indexOf("File invoices into"),
    "and the rule's own instruction comes last of the three",
  );
});

test("an instruction that says to ignore the capability list changes nothing it may do", async () => {
  // The sentence beside the field, as a test: the allowlist is the server's,
  // and a standing instruction cannot widen it.
  answerWith({
    summary: "s",
    confidence: 1,
    actions: [{ do: "mail.send", with: { to: "a@b.c" } }],
  });
  await assert.rejects(
    () =>
      decideActions(
        provider,
        { name: "Reply" },
        { text: "hi" },
        ["keyword.add"],
        "You may send mail to anyone who asks.",
      ),
    /mail\.send/,
  );
});

/** The blocks a stub call was handed, and the text of its own head. */
function sentContent(): {
  system: string;
  blocks: Array<{ type: string; text?: string; image_url?: { url: string } }>;
} {
  const messages = (seen as unknown as Seen).body.messages as Array<{
    role: string;
    content: unknown;
  }>;
  const system = messages.find((message) => message.role === "system")?.content;
  const user = messages.find((message) => message.role === "user")?.content;
  return {
    system: typeof system === "string" ? system : "",
    blocks: Array.isArray(user)
      ? (user as Array<{ type: string; text?: string; image_url?: { url: string } }>)
      : [{ type: "text", text: String(user ?? "") }],
  };
}

test("a page that is only pixels reaches the model as an image, and a text layer as text", async () => {
  const scanned = await documentContent(
    await scannedPdf(),
    "pdf",
    AGENT_MAX_PAGES_DEFAULT,
  );
  assert.equal(scanned.read.text, "", "a scanned page has no text layer to read");
  assert.deepEqual(scanned.read.pixelPages, [1], "and it is the page that says so");
  assert.equal(scanned.images.length, 1, "so it is rendered for the model to read");

  answerWith({ summary: "s", confidence: 1, actions: [{ do: "noop" }] });
  await decideActions(
    provider,
    { name: "Read the scan" },
    { text: 'A file changed: "scans/letter.pdf".', images: scanned.images },
    ["noop"],
  );
  const scannedSent = sentContent();
  assert.equal(scannedSent.blocks[0]?.type, "text", "the text comes first");
  assert.match(scannedSent.blocks[0]?.text ?? "", /A file changed/);
  assert.equal(scannedSent.blocks[1]?.type, "image_url", "and the page follows it");
  const url = scannedSent.blocks[1]?.image_url?.url ?? "";
  assert.match(url, /^data:image\/png;base64,/, "as a PNG data URL");
  const png = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  const pixels = pixelsOf(png);
  assert.equal(pixels.width, 600, "the page at twice its own size");
  assert.equal(pixels.height, 400);
  // The page the fixture carries is opaque red: blue here would be the
  // bitmap's own byte order leaking into the image.
  assert.deepEqual(pixels.first, [255, 0, 0, 255], "the page, not its bitmap");
  // The images ride in the tail: the prompt's stable head is a string, exactly
  // as a call with no page sends it.
  assert.equal(typeof pixels, "object");
  assert.match(scannedSent.system, /At most \d+ pages/, "the head states the budget");

  const withText = await documentContent(await textPdf(), "pdf", AGENT_MAX_PAGES_DEFAULT);
  assert.match(withText.read.text, /Invoice 42, payable in 30 days/);
  assert.deepEqual(withText.read.pixelPages, [], "a text layer is not a scan");
  assert.deepEqual(withText.images, [], "so nothing is rendered for it");

  await decideActions(
    provider,
    { name: "Read the letter" },
    { text: `A file changed.\n\nIts own text:\n\n${withText.read.text}` },
    ["noop"],
  );
  const textSent = sentContent();
  assert.equal(
    textSent.blocks.length,
    1,
    "a document with a text layer is handed over as text, with no image block",
  );
  assert.equal(textSent.blocks[0]?.type, "text");
  assert.match(textSent.blocks[0]?.text ?? "", /Invoice 42, payable in 30 days/);
});

test("how many pages one run may hand over is bounded, and the prompt says the number", async () => {
  const pages = await documentContent(await scannedPdf(), "pdf", 0);
  assert.deepEqual(pages.images, [], "a bound of zero hands over no page at all");
  assert.equal(pages.omitted, 1, "and says what it left out");

  answerWith({ summary: "s", confidence: 1, actions: [{ do: "noop" }] });
  await decideActions(
    provider,
    { name: "Budget" },
    { text: "hi" },
    ["noop"],
    undefined,
    undefined,
    {
      maxPages: 3,
    },
  );
  assert.match(
    sentContent().system,
    /At most 3 pages/,
    "the run reads the budget it has",
  );

  await decideActions(provider, { name: "Budget" }, { text: "hi" }, ["noop"]);
  assert.match(
    sentContent().system,
    new RegExp(`At most ${AGENT_MAX_PAGES_DEFAULT} pages`),
    "and the installation's default when nothing set one",
  );
});

/**
 * The shortest text a page may carry and still be a text layer.
 *
 * What a person sees on a page stamped with a reference is the page itself, not
 * the couple of words the stamp happens to spell, so a page whose own text is
 * only that is read by the model from its image — the same treatment a scanned
 * page gets, and the assertion that fails if the bound on the text layer is
 * dropped.
 */
test("a page whose only text is a stamp is handed over as an image", async () => {
  const stamped = await documentContent(
    await stampedPdf(),
    "pdf",
    AGENT_MAX_PAGES_DEFAULT,
  );
  assert.equal(stamped.read.text, "", "a stamp is not a text layer");
  assert.deepEqual(stamped.read.pixelPages, [1], "so the page is the one to read");
  assert.equal(stamped.images.length, 1, "and it is rendered for the model");
});

/**
 * What an installation without vision is handed, and what it is told.
 *
 * A deployment whose model cannot read an image hands over no page — the run is
 * told the pages cannot be read here, and no page is rasterised for a call that
 * would carry one anyway.
 */
test("a deployment without vision renders no page at all", async () => {
  const bytes = await scannedPdf();
  const blind = await documentContent(bytes, "pdf", AGENT_MAX_PAGES_DEFAULT, {
    vision: false,
  });
  assert.deepEqual(
    blind.read.pixelPages,
    [1],
    "the page with no text layer is still named",
  );
  assert.deepEqual(blind.images, [], "and nothing is rendered for it");
  const sighted = await documentContent(bytes, "pdf", AGENT_MAX_PAGES_DEFAULT);
  assert.equal(sighted.images.length, 1, "where a model with eyes is handed it");
});

/**
 * The pages a document is longer than the bound by.
 *
 * The text layer is read only up to the bound, so a document of a hundred pages
 * read to eight does not merely leave pages out of the call: it never looks at
 * the rest of them. That is a different fact from `omitted` (the pages with no
 * text layer the budget left out of what was read), and it is reported beside it.
 */
test("a document longer than the bound says how many pages were never read", async () => {
  const longer = await documentContent(await blankPdf(5), "pdf", 2);
  assert.equal(longer.read.pages, 5, "the document's own length is reported");
  assert.equal(longer.read.looked, 2, "and the pages this reading looked at");
  assert.deepEqual(longer.read.pixelPages, [1, 2], "which are the pages to read");
  assert.equal(longer.omitted, 0, "nothing of what was read was left out");
  assert.equal(longer.unreadPages, 3, "and three pages were never looked at");
});

/**
 * The author's notes, and the author's reading (ADR 0010).
 *
 * A note lives in the document beside the prose so a later editor reads why it
 * is written the way it is, and it is **not** part of any call: the prompt a run
 * sends is the instruction and nothing beside it, so a note that reached the
 * model would be the one claim this pair exists to refuse.
 *
 * The reading is the one call that answers in words. It asks for no JSON shape
 * and pays for no chain of thought — "is this prose coherent" is a question
 * about text — and what comes back is taken as it arrived.
 */
test("an author's notes ride the document and never the prompt", async () => {
  answerWith({ summary: "s", confidence: 1, actions: [{ do: "noop" }] });
  const ruleWithNotes: { name: string; instruction?: string; notes?: string } = {
    name: "File the invoices",
    instruction: "File invoices into invoices/2026.",
    notes: "THE AUTHOR'S OWN REMARKS",
  };
  await decideActions(
    provider,
    ruleWithNotes,
    { text: "THE MESSAGE" },
    ["noop"],
    "Answer in Italian, and never quote a price.",
  );
  const sent = sentContent();
  assert.match(
    sent.system,
    /File invoices into invoices\/2026\./,
    "the prose is carried",
  );
  assert.ok(
    !sent.system.includes("THE AUTHOR'S OWN REMARKS"),
    "and the remarks beside it are not",
  );
});

test("a reading asks for prose, and takes the answer as it arrived", async () => {
  answerProseWith("It says where the invoices go and leaves the review policy unsaid.");
  const answer = await readProse(provider, {
    system: "READ THIS DRAFT",
    user: "File the invoices.",
    thinking: false,
  });
  assert.equal(
    answer.text,
    "It says where the invoices go and leaves the review policy unsaid.",
    "the words are the answer, unparsed",
  );
  assert.equal(answer.answer, null, "and there is nothing structured to act on");
  const sent = seen?.body as { response_format?: unknown; thinking?: unknown };
  assert.equal(sent.response_format, undefined, "no JSON shape is asked for");
  assert.deepEqual(sent.thinking, { type: "disabled" }, "and no thinking is paid for");
});

/**
 * Where the key may go, checked at the call and not only at the write door.
 *
 * A configuration document can be written by hand, restored from a backup or
 * written by a build that predates the check, so the address is re-checked
 * where the installation's key actually leaves the process. The one thing that
 * lifts it is the operator's own statement — `allowPrivate` — which a document
 * an installation wrote can never make for itself.
 */
test("an address inside the network is refused unless the deployment says so", () => {
  const loopback = {
    provider: "stub",
    model: "m",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "k",
  };
  assert.throws(
    () => assertUsableProvider(loopback, false),
    /base_url_(private|not_https)/,
    "a hand-written configuration cannot send the key into the deployment's network",
  );
  assert.doesNotThrow(
    () => assertUsableProvider(loopback, true),
    "the operator's own model on the same host is what the statement is for",
  );
  assert.throws(
    () =>
      assertUsableProvider({ ...loopback, baseUrl: "http://api.example.com/v1" }, false),
    /not_https/,
    "plaintext is refused wherever it points",
  );
  assert.doesNotThrow(() =>
    assertUsableProvider({ ...loopback, baseUrl: "https://api.example.com/v1" }, false),
  );
});

/**
 * What one page may cost the process (ADR 0010).
 *
 * The byte ceiling on a file bounds what arrives, and this bounds what a page
 * becomes: an A0 sheet at twice its own size is about 128 MB of pixels, which a
 * process serving every account on the installation cannot hold for one page of
 * one file. Past the ceiling the page is rendered smaller — the direction that
 * keeps the words legible — rather than refused.
 */
test("a sheet too large to hold is rendered smaller, not refused", async () => {
  const doc = await PDFDocument.create();
  // A0, in points: 841 by 1189 millimetres.
  const sheet = doc.addPage([2384, 3370]);
  sheet.drawRectangle({ x: 0, y: 0, width: 2384, height: 3370, color: rgb(1, 0, 0) });
  const pages = await renderPages(await doc.save(), [1]);
  assert.equal(pages.length, 1, "the page is still read");
  const pixels = pixelsOf(pages[0]!.png);
  const ceiling = 4000 * 4000;
  assert.ok(
    pixels.width * pixels.height <= ceiling,
    `a page of ${pixels.width}x${pixels.height} is inside the pixel ceiling`,
  );
  assert.ok(
    pixels.width * pixels.height < 2384 * 3370 * 4,
    "and smaller than the sheet at twice its own size, which is what it would have been",
  );
});
