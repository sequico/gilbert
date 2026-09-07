import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import type { SetResponse } from "@/jmap/types";
import { useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";

/**
 * Draft saves, serialised per draft.
 *
 * Saving a draft is Email/set create + destroy of the draft it replaces, and
 * the autosave timer, a manual Save, closing and sending used to be able to
 * overlap a save still in flight. Each then destroyed only the id it had
 * captured, so the save that finished last left its create behind: a send
 * could orphan a $draft of the message just sent, two overlapping saves left
 * two drafts, and a save finishing over newer typing cleared `dirty`, so a
 * close that followed skipped its own save and dropped the newest content.
 *
 * These pin the queue: one save at a time per draft, send and discard waiting
 * for the queue and destroying the draft the last save actually created, and
 * completion clearing `dirty` only over content that is still current.
 */

/** A promise the test resolves by hand, so a save can be held in flight. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Let queued microtasks (and the odd macrotask) run. */
const flush = () => new Promise<void>((res) => setTimeout(res, 0));

/** What a save asked the server to destroy, in order. */
const destroyLog: string[][] = [];
/** Drafts the mock server is holding, by id. */
const serverDrafts = new Map<string, string>();
/** Email/set responses, one per save; a test pushes gates to hold saves open. */
const gates: Array<{ promise: Promise<unknown>; resolve: () => void }> = [];

let draftSeq = 0;

function emailSetResponse(args: Record<string, unknown>): SetResponse {
  const created = (args.create ?? {}) as Record<string, unknown>;
  const destroyed = ((args.destroy as string[] | undefined) ?? []).slice();
  destroyLog.push(destroyed);
  for (const id of destroyed) serverDrafts.delete(id);
  const name = Object.keys(created)[0];
  const obj = name ? (created[name] as Record<string, unknown>) : null;
  let createdId: string | null = null;
  if (obj) {
    createdId = `d${++draftSeq}`;
    serverDrafts.set(createdId, JSON.stringify(obj));
  }
  return {
    accountId: "a1",
    ...(createdId ? { created: { [name!]: { id: createdId } } } : { created: {} }),
    destroyed: Object.fromEntries(destroyed.map((id) => [id, null])),
  } as unknown as SetResponse;
}

async function emailSet(args: Record<string, unknown>): Promise<unknown> {
  const gate = gates.shift();
  if (gate) await gate.promise;
  return emailSetResponse(args);
}

let openDraft: string | null = null;

beforeEach(() => {
  vi.restoreAllMocks();
  destroyLog.length = 0;
  serverDrafts.clear();
  gates.length = 0;
  draftSeq = 0;
  openDraft = null;
  useCompose.setState({ drafts: [], activeKey: null, pendingSends: {} });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, undoSendSeconds: 0 } });
  useMail.setState({
    accountId: "a1",
    identities: [
      { id: "i1", name: "John", email: "john@example.org", replyTo: null },
    ] as never,
    mailboxes: {
      mb1: { id: "mb1", role: "sent", name: "Sent" },
      mb2: { id: "mb2", role: "drafts", name: "Drafts" },
    } as never,
    list: null,
    loadMailboxes: (async () => undefined) as never,
    refreshList: (async () => undefined) as never,
  });
  vi.spyOn(client, "call").mockImplementation(async (method, args) => {
    if (method !== "Email/set") return { accountId: "a1" };
    return emailSet(args);
  });
  vi.spyOn(client, "chain").mockImplementation(async (calls) => {
    const out = new Map<string, Record<string, unknown>[]>();
    for (const [method, args, id] of calls) {
      if (method === "Email/set") {
        const created = (args.create ?? {}) as Record<string, unknown>;
        const destroyed = ((args.destroy as string[] | undefined) ?? []).slice();
        destroyLog.push(destroyed);
        for (const d of destroyed) serverDrafts.delete(d);
        const m = created.m as Record<string, unknown> | undefined;
        out.set(id, [
          {
            accountId: "a1",
            created: m ? { m: { id: `m-${id}` } } : {},
          },
        ]);
      } else if (method === "EmailSubmission/set") {
        out.set(id, [{ accountId: "a1", created: { s: { id: `sub-${id}` } } }]);
      } else out.set(id, [{}]);
    }
    return out;
  });
  openDraft = useCompose.getState().open({
    identityId: "i1",
    draftId: "orig",
    to: [{ name: null, email: "ann@example.com" }],
    subject: "Hi",
    html: "<div>v1</div>",
    text: "v1",
    dirty: true,
  });
  serverDrafts.set("orig", "old draft on the server");
});

afterEach(() => {
  // A draft still open schedules real 20 s autosave timers; close it so the
  // environment is left tidy.
  if (openDraft && useCompose.getState().drafts.some((d) => d.key === openDraft)) {
    vi.spyOn(client, "call").mockResolvedValue({
      accountId: "a1",
      created: {},
      destroyed: {},
    } as never);
    void useCompose.getState().close(openDraft, { discard: true });
  }
  openDraft = null;
});

describe("a save in flight when Send is clicked", () => {
  it("leaves no draft behind: the send destroys the draft the save created", async () => {
    const key = openDraft!;
    const gate = deferred();
    gates.push({ promise: gate.promise, resolve: () => gate.resolve() });
    // The autosave timer fires into this same `saveDraft`, so holding the
    // call open is holding the autosave in flight.
    const saving = useCompose.getState().saveDraft(key, { silent: true });
    await flush();
    expect(serverDrafts.has("orig")).toBe(true);
    const sending = useCompose.getState().send(key);
    await flush();
    gate.resolve();
    await saving;
    await sending;
    // The draft d1 that the in-flight save created was destroyed by the send's
    // Email/set — not "orig", which the save itself had already replaced.
    expect(destroyLog.some((d) => d.includes("d1"))).toBe(true);
    expect([...serverDrafts.keys()]).toEqual([]);
  });
});

describe("two saves that overlap", () => {
  it("leave one draft: the second destroys the first's create", async () => {
    const key = openDraft!;
    const gate = deferred();
    gates.push({ promise: gate.promise, resolve: () => gate.resolve() });
    const first = useCompose.getState().saveDraft(key, { silent: true });
    await flush();
    // Typing while the first save is in flight, then another save trigger
    // (the user hits Save, or a second autosave beat) before it settles.
    useCompose.getState().update(key, { subject: "Hi v2" });
    const second = useCompose.getState().saveDraft(key, { silent: true });
    await flush();
    gate.resolve();
    await first;
    await second;
    // Each save destroyed the draft the previous one created, so exactly one
    // draft survives, holding the newest content.
    expect(destroyLog[0]).toEqual(["orig"]);
    expect(destroyLog[1]).toEqual(["d1"]);
    expect(serverDrafts.size).toBe(1);
    const [id, body] = [...serverDrafts.entries()][0]!;
    expect(id).toBe("d2");
    expect(JSON.parse(body).subject).toBe("Hi v2");
  });
});

describe("a save that finishes over newer typing", () => {
  it("does not clear dirty, and a close that follows saves the newest content", async () => {
    const key = openDraft!;
    const gate = deferred();
    gates.push({ promise: gate.promise, resolve: () => gate.resolve() });
    const saving = useCompose.getState().saveDraft(key, { silent: true });
    await flush();
    useCompose.getState().update(key, { subject: "Hi v3" });
    gate.resolve();
    await saving;
    const d = useCompose.getState().drafts.find((x) => x.key === key)!;
    // The save persisted the first content, but the draft holds v3: dirty
    // must survive so the close that follows saves again rather than
    // dropping v3.
    expect(d.dirty).toBe(true);
    expect(d.draftId).toBe("d1");
    await useCompose.getState().close(key);
    expect(serverDrafts.size).toBe(1);
    const [id, body] = [...serverDrafts.entries()][0]!;
    expect(id).toBe("d2");
    expect(JSON.parse(body).subject).toBe("Hi v3");
    openDraft = null; // closed already
  });
});

describe("discarding while a save is in flight", () => {
  it("destroys the draft the save created, not the one it replaced", async () => {
    const key = openDraft!;
    const gate = deferred();
    gates.push({ promise: gate.promise, resolve: () => gate.resolve() });
    const saving = useCompose.getState().saveDraft(key, { silent: true });
    await flush();
    const closing = useCompose.getState().close(key, { discard: true });
    await flush();
    gate.resolve();
    await saving;
    await closing;
    expect(destroyLog.some((d) => d.includes("d1"))).toBe(true);
    expect([...serverDrafts.keys()]).toEqual([]);
    openDraft = null; // closed already
  });
});
