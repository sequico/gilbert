import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import type { SieveScript } from "@/jmap/types";
import { newRule, rulesToSieve } from "@/lib/sieve";
import { useSieve } from "@/store/sieve";

/**
 * Issue #76: adding a filter from a message reported success, and the script
 * on the server never held more than two rules.
 *
 * The chain was three links long, and each looked reasonable alone:
 *
 *   1. `load()` recorded a *failed* blob fetch as `contents[id] = ""`.
 *   2. `sieveToRules("")` returns `[]` — "this script has no rules", which is
 *      indistinguishable from "we could not read this script".
 *   3. Saving writes the whole script from that baseline, so every existing
 *      rule was deleted, and the UI reported success because the write worked.
 *
 * The fix is to keep "unknown" and "empty" apart at every step. These pin that:
 * an unreadable script must never present as an empty one.
 */

const SCRIPT: SieveScript = {
  id: "s1",
  name: "gilbert",
  isActive: true,
  blobId: "b1",
} as SieveScript;
const threeRules = [
  newRule({ name: "One" }),
  newRule({ name: "Two" }),
  newRule({ name: "Three" }),
];

beforeEach(() => {
  useSieve.setState({
    accountId: "a1",
    scripts: [SCRIPT],
    contents: {},
    loading: false,
    error: null,
  });
});

describe("a script whose content could not be read", () => {
  it("reports its rules as unknown, not as none", () => {
    // contents is empty: the fetch failed, or has not happened yet.
    const { rules, loaded } = useSieve.getState().rules();
    expect(rules).toBeNull();
    expect(loaded).toBe(false);
  });

  it("refuses to save rather than overwriting what it cannot see", async () => {
    await expect(
      useSieve.getState().saveRules([newRule({ name: "New" })]),
    ).rejects.toThrow(/could not be read/i);
  });

  it("says so in terms that point at the fix", async () => {
    // "Reload and try again" is recoverable advice; a generic failure is not.
    await expect(
      useSieve.getState().saveRules([newRule({ name: "New" })]),
    ).rejects.toThrow(/reload/i);
  });
});

describe("a script that is genuinely empty", () => {
  it("is distinguishable from one that could not be read", () => {
    useSieve.setState({ contents: { s1: "" } });
    const { rules, loaded } = useSieve.getState().rules();
    expect(loaded).toBe(true);
    expect(rules).toEqual([]);
  });
});

describe("a script that was read", () => {
  it("hands back every rule in it", () => {
    useSieve.setState({ contents: { s1: rulesToSieve(threeRules) } });
    const { rules, loaded } = useSieve.getState().rules();
    expect(loaded).toBe(true);
    expect(rules).toHaveLength(3);
    expect(rules?.map((r) => r.name)).toEqual(["One", "Two", "Three"]);
  });

  it("does not lose rules across a save-shaped round trip", () => {
    // The regression in one line: N rules in, N + 1 out after adding one.
    useSieve.setState({ contents: { s1: rulesToSieve(threeRules) } });
    const before = useSieve.getState().rules().rules!;
    const after = [...before, newRule({ name: "Four" })];
    useSieve.setState({ contents: { s1: rulesToSieve(after) } });
    expect(useSieve.getState().rules().rules).toHaveLength(4);
  });
});

describe("reloading", () => {
  it("does not discard content it already holds when a refetch yields nothing", () => {
    // saveScript caches what it just wrote, then reloads. A reload whose fetch
    // failed used to replace the whole map and wipe that.
    useSieve.setState({ contents: { s1: rulesToSieve(threeRules) } });
    const kept = useSieve.getState().contents.s1;
    useSieve.setState((st) => ({ contents: { ...st.contents } })); // merge, not replace
    expect(useSieve.getState().contents.s1).toBe(kept);
    expect(useSieve.getState().rules().rules).toHaveLength(3);
  });
});

/**
 * Issue #76, second round. The transport fault is fixed in the blob proxy, but
 * the save path had no answer for a script that arrives *partly* read: it is
 * neither unknown nor empty, so the guards above all pass it through. It parses
 * into a shorter rule list that looks exactly like a script with fewer rules,
 * and saving writes that shorter version back over the real one.
 *
 * These pin the third state: read, but not all of it.
 */
describe("a script that was only partly read", () => {
  /** Cut at 384 bytes, the way a compressing hop cut the reporter's script. */
  const truncate = (content: string, at: number) => content.slice(0, at);
  const full = rulesToSieve(threeRules);

  it("reports its rules as unknown rather than handing back the ones that parsed", () => {
    useSieve.setState({ contents: { s1: truncate(full, 384) } });
    const { rules, loaded, damage } = useSieve.getState().rules();
    expect(rules).toBeNull();
    expect(loaded).toBe(true);
    expect(damage).toBeTruthy();
  });

  it("refuses to save over the part it never saw", async () => {
    useSieve.setState({ contents: { s1: truncate(full, 384) } });
    await expect(
      useSieve.getState().saveRules([newRule({ name: "New" })]),
    ).rejects.toThrow(/overwrite the rest of it/i);
  });

  it("catches a cut at every offset through the script, not just a lucky one", () => {
    // The offsets that cannot be caught are the ends of complete rule blocks:
    // each is a valid shorter script and nothing in the bytes says otherwise.
    // That is the residual the proxy fix covers and this check cannot.
    const safe = new Set<number>();
    for (let n = 0; n <= threeRules.length; n++)
      safe.add(rulesToSieve(threeRules.slice(0, n)).length);
    let missed = 0;
    for (let at = 1; at < full.length; at++) {
      useSieve.setState({ contents: { s1: truncate(full, at) } });
      const { damage } = useSieve.getState().rules();
      if (!damage && !safe.has(at)) missed++;
    }
    expect(missed).toBe(0);
  });

  it("leaves an intact script alone at every length it can legitimately have", () => {
    for (let n = 0; n <= threeRules.length; n++) {
      useSieve.setState({ contents: { s1: rulesToSieve(threeRules.slice(0, n)) } });
      const { rules, damage } = useSieve.getState().rules();
      expect(damage).toBeNull();
      expect(rules).toHaveLength(n);
    }
  });

  it("leaves the shapes a rule can take alone — disabled, many actions, extensions", () => {
    // A false positive here costs someone the use of the rules editor, so the
    // walk has to pass everything rulesToSieve can legitimately produce.
    const varied = [
      newRule({ name: "Disabled", enabled: false }),
      newRule({
        name: "Many actions",
        actions: [
          { type: "fileinto", mailbox: "A" },
          { type: "markread" },
          { type: "flag" },
          { type: "stop" },
        ],
      }),
      newRule({
        name: "Two tests",
        join: "anyof",
        tests: [
          { type: "body", op: "contains", value: "x" },
          { type: "size", op: "over", value: 1024 },
        ],
      }),
      newRule({ name: "No actions at all", actions: [] }),
      newRule({ name: 'Quotes " and \\ backslash' }),
    ];
    useSieve.setState({ contents: { s1: rulesToSieve(varied) } });
    const { rules, damage } = useSieve.getState().rules();
    expect(damage).toBeNull();
    expect(rules).toHaveLength(varied.length);
  });

  it("catches a cut at every offset through that script too", () => {
    const varied = [
      newRule({ name: "Disabled", enabled: false }),
      newRule({ name: "Live" }),
      newRule({ name: "Also off", enabled: false }),
    ];
    const full = rulesToSieve(varied);
    const safe = new Set<number>();
    for (let n = 0; n <= varied.length; n++)
      safe.add(rulesToSieve(varied.slice(0, n)).length);
    let missed = 0;
    for (let at = 1; at < full.length; at++) {
      useSieve.setState({ contents: { s1: full.slice(0, at) } });
      if (!useSieve.getState().rules().damage && !safe.has(at)) missed++;
    }
    expect(missed).toBe(0);
  });

  it("does not call a hand-written script damaged", () => {
    useSieve.setState({
      contents: {
        s1: 'require ["fileinto"];\nif header :contains "from" "x" { fileinto "X"; }',
      },
    });
    const { rules, damage } = useSieve.getState().rules();
    expect(damage).toBeNull();
    expect(rules).toBeNull(); // hand-written, which is a different refusal
  });
});

/**
 * A hand-written script that happens to be named "gilbert".
 *
 * The rules editor always saves into the script named gilbert, and "Start
 * with rules" promises the existing script is kept and deactivated, not
 * deleted. Updating the script in place would have kept the name and the
 * active slot but replaced the hand-written content with the generated one —
 * destroying the author's script while appearing to honour the promise.
 *
 * These pin the actual behaviour: the hand-written one is renamed aside and
 * deactivated, content untouched, and a fresh managed script takes over.
 */
describe("a hand-written script named gilbert", () => {
  const HAND = 'require ["fileinto"];\nif header :contains "from" "x" { fileinto "X"; }';
  const scripts: Array<{ id: string; name: string; isActive: boolean; blobId: string }> =
    [];
  const blobs = new Map<string, string>();
  let seq = 0;

  beforeEach(() => {
    scripts.length = 0;
    blobs.clear();
    seq = 0;
    scripts.push({ id: "s1", name: "gilbert", isActive: true, blobId: "b-hand" });
    blobs.set("b-hand", HAND);
    useSieve.setState({
      accountId: "a1",
      scripts: [...scripts],
      contents: { s1: HAND },
      loading: false,
      error: null,
    });
    vi.spyOn(client, "upload").mockImplementation(async (_accountId, blob) => {
      // jsdom Blob has no .text(); a FileReader reads it fine.
      const text = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsText(blob as Blob);
      });
      const id = `b${++seq}`;
      blobs.set(id, text);
      return { blobId: id, type: "application/sieve", size: 0 } as never;
    });
    vi.spyOn(client, "fetchBlobText").mockImplementation(
      async (_accountId, blobId) => blobs.get(blobId as string) ?? "",
    );
    vi.spyOn(client, "call").mockImplementation(async (method, args) => {
      if (method === "SieveScript/set") {
        const out: Record<string, unknown> = { accountId: "a1" };
        const update = args.update as
          | Record<string, { name?: string; blobId?: string }>
          | undefined;
        if (update)
          for (const [id, patch] of Object.entries(update)) {
            const s = scripts.find((x) => x.id === id);
            if (!s) {
              out.notUpdated = { [id]: { type: "notFound" } };
              continue;
            }
            if (patch.name !== undefined) s.name = patch.name;
            if (patch.blobId !== undefined) s.blobId = patch.blobId;
            out.updated = { [id]: null };
          }
        const create = args.create as
          | Record<string, { name: string; blobId: string }>
          | undefined;
        const created: Record<string, unknown> = {};
        let createdId: string | null = null;
        if (create)
          for (const [k, o] of Object.entries(create)) {
            createdId = `s${++seq}`;
            scripts.push({
              id: createdId,
              name: o.name,
              blobId: o.blobId,
              isActive: false,
            });
            created[k] = { id: createdId };
          }
        const act = args.onSuccessActivateScript as string | undefined;
        if (act) {
          const id = act.startsWith("#") ? createdId : act;
          for (const s of scripts) s.isActive = s.id === id;
        }
        if (args.onSuccessDeactivateScript) for (const s of scripts) s.isActive = false;
        return { ...out, created };
      }
      if (method === "SieveScript/get")
        return {
          accountId: "a1",
          state: "1",
          list: scripts.map((s) => ({ ...s })),
          notFound: [],
        };
      return { accountId: "a1" };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is set aside under a dated name, not overwritten, when rules take over", async () => {
    await useSieve.getState().saveRules([newRule({ name: "Fresh" })]);
    const scriptsNow = useSieve.getState().scripts;
    expect(scriptsNow).toHaveLength(2);
    const active = scriptsNow.find((s) => s.isActive);
    expect(active?.name).toBe("gilbert");
    expect(active?.id).not.toBe("s1");
    const aside = scriptsNow.find((s) => s.id === "s1");
    expect(aside?.isActive).toBe(false);
    expect(aside?.name).toMatch(/^gilbert — saved \d{4}-\d{2}-\d{2}$/);
    // The hand-written content survived untouched, on the same blob.
    expect(blobs.get(aside!.blobId)).toBe(HAND);
    // And the fresh script holds the managed rules.
    expect(blobs.get(active!.blobId)).toContain("# rule:");
  });

  it("does not rename a managed gilbert script, which is updated in place", async () => {
    const managed = rulesToSieve([newRule({ name: "Managed" })]);
    scripts[0] = { id: "s1", name: "gilbert", isActive: true, blobId: "b-hand" };
    blobs.set("b-hand", managed);
    useSieve.setState({ scripts: [...scripts], contents: { s1: managed } });
    await useSieve.getState().saveRules([newRule({ name: "Extra" })]);
    const scriptsNow = useSieve.getState().scripts;
    expect(scriptsNow).toHaveLength(1);
    expect(scriptsNow[0]!.name).toBe("gilbert");
    expect(scriptsNow[0]!.isActive).toBe(true);
    expect(blobs.get(scriptsNow[0]!.blobId)).toContain('"Extra"');
  });
});
