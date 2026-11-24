import { errorMessage } from "@gilbert/shared/errors";
import { create } from "zustand";
import { CAP, client, setErrorMessage } from "@/jmap/client";
import type { GetResponse, Id, SetResponse, SieveScript } from "@/jmap/types";
import {
  isManagedScript,
  MANAGED_INCLUDE,
  rulesToSieve,
  type SieveRule,
  scriptDamage,
  sieveToRules,
} from "@/lib/sieve";
import { useSession } from "./session";

const GILBERT_SCRIPT = "gilbert";

interface SieveState {
  accountId: Id | null;
  available: boolean;
  scripts: SieveScript[];
  /** Content of each script by id. */
  contents: Record<Id, string>;
  loading: boolean;
  error: string | null;
  init(): Promise<void>;
  load(): Promise<void>;
  getContent(id: Id): Promise<string>;
  /** Rules derived from the "gilbert" script (null = the active script is hand-written). */
  /** `loaded` distinguishes "this script is hand-written" from "we could not read it". */
  rules(): {
    script: SieveScript | null;
    rules: SieveRule[] | null;
    content: string;
    loaded: boolean;
    damage: string | null;
  };
  saveRules(rules: SieveRule[]): Promise<void>;
  saveScript(
    id: Id | null,
    name: string,
    content: string,
    activate: boolean,
  ): Promise<Id>;
  activate(id: Id | null): Promise<void>;
  destroy(id: Id): Promise<void>;
  validate(content: string): Promise<string | null>;
  applyChanges(types: Set<string>): void;
}

export const useSieve = create<SieveState>((set, get) => ({
  accountId: null,
  available: false,
  scripts: [],
  contents: {},
  loading: false,
  error: null,

  async init() {
    const accountId = useSession.getState().ownAccountFor(CAP.sieve);
    const available = Boolean(accountId && client.hasCapability(CAP.sieve));
    /*
     * A different account's session starts from nothing. Scripts and their
     * contents are that account's own (a script is a file on its server), so a
     * sign-in that follows another must not read -- or save from -- the text the
     * previous account's scripts had.
     */
    if (get().accountId !== accountId)
      set({
        accountId,
        available,
        scripts: [],
        contents: {},
        loading: false,
        error: null,
      });
    else set({ accountId, available });
    if (available) await get().load();
  },

  async load() {
    const accountId = get().accountId;
    if (!accountId) return;
    set({ loading: true });
    try {
      const res = await client.call<GetResponse<SieveScript>>("SieveScript/get", {
        accountId,
        ids: null,
      });
      set({ scripts: res.list, loading: false, error: null });
      // Preload contents.
      //
      // A fetch that fails must not be recorded as "". An empty script parses
      // to an empty rule list, which reads as "this script has no rules" and is
      // indistinguishable from "we could not read this script" -- and the next
      // save then writes the whole script out from that empty baseline,
      // destroying every rule in it. That is issue #76.
      //
      // Leaving the key absent instead means `rules()` reports the content as
      // unknown, and `saveRules` refuses rather than guessing.
      const fetched: Record<Id, string> = {};
      await Promise.all(
        res.list
          // The compiled script is never shown or edited here, so its text is
          // a download nobody reads.
          .filter((s) => !isManagedScript(s))
          .map(async (s) => {
            try {
              fetched[s.id] = await client.fetchBlobText(
                accountId,
                s.blobId,
                "application/sieve",
              );
            } catch {
              /* leave absent: unknown, not empty */
            }
          }),
      );
      // Merged, not replaced: saveScript caches the content it just wrote, and
      // a reload whose fetch failed must not throw that away.
      set((st) => ({ contents: { ...st.contents, ...fetched } }));
      await adoptManaged(get);
    } catch (err) {
      set({ loading: false, error: errorMessage(err) });
    }
  },

  async getContent(id) {
    const cached = get().contents[id];
    if (cached != null) return cached;
    const s = get().scripts.find((x) => x.id === id);
    if (!s) return "";
    const text = await client.fetchBlobText(
      get().accountId!,
      s.blobId,
      "application/sieve",
    );
    set((st) => ({ contents: { ...st.contents, [id]: text } }));
    return text;
  },

  rules() {
    const { scripts, contents } = get();
    const script =
      scripts.find((s) => s.name === GILBERT_SCRIPT) ??
      // The server's own script is never the baseline of these rules: editing
      // it is refused by the server and it is not one a person wrote here.
      scripts.find((s) => s.isActive && !isManagedScript(s)) ??
      null;
    if (!script)
      return { script: null, rules: [], content: "", loaded: true, damage: null };
    const content = contents[script.id];
    // Not loaded, or the fetch failed. `null` means "cannot say", which every
    // caller already treats as "do not edit this script" -- as opposed to `[]`,
    // which means "this script genuinely has no rules" and invites a save that
    // would overwrite whatever is really in it.
    if (content === undefined)
      return { script, rules: null, content: "", loaded: false, damage: null };
    // Read, but not all of it. Showing the rules that did parse would be the
    // most dangerous thing available: a short list that looks complete, over a
    // script that is not. Say "cannot say" here too.
    const damage = scriptDamage(content);
    if (damage) return { script, rules: null, content, loaded: true, damage };
    return { script, rules: sieveToRules(content), content, loaded: true, damage: null };
  },

  async saveRules(rules) {
    const existing = get().scripts.find((s) => s.name === GILBERT_SCRIPT) ?? null;
    /*
     * Stalwart 1.2 keeps a person's rules and away reply in a script it
     * compiles, which applies only while it is active or the active script
     * includes it. The list says whether this server has one; on an older one
     * the include would name a script that does not exist and fail to compile.
     */
    const text = rulesToSieve(rules, {
      includeManaged: get().scripts.some(isManagedScript),
    });
    // The last line of defence. Writing rules replaces the whole script, so
    // doing it from a baseline we never managed to read deletes whatever was
    // there. Refusing is recoverable; overwriting is not.
    if (existing) {
      const content = get().contents[existing.id];
      if (content === undefined) {
        throw new Error(
          "Your filter script could not be read, so saving would overwrite it. Reload and try again.",
        );
      }
      // Read in full is a separate question from read at all, and the answer
      // that cost rules in #76 was "partly". A baseline missing its tail writes
      // out just as confidently as one missing entirely.
      const damage = scriptDamage(content);
      if (damage) {
        throw new Error(
          `Your filter script ${damage}, so saving would overwrite the rest of it. Reload and try again.`,
        );
      }
      /*
       * A hand-written script that happens to be named "gilbert" is not a
       * managed one to update in place: overwriting it would silently destroy
       * what its author wrote, which is exactly what "Start with rules"
       * promises will not happen (it says the existing script is kept and
       * deactivated). Set it aside under a dated name instead -- the create
       * below activates the fresh script, which deactivates this one -- and
       * leave its content untouched.
       */
      if (sieveToRules(content) === null) {
        const aside = `${GILBERT_SCRIPT} — saved ${new Date().toISOString().slice(0, 10)}`;
        const res = await client.call<SetResponse<SieveScript>>("SieveScript/set", {
          accountId: get().accountId,
          update: { [existing.id]: { name: aside } },
        });
        const err = res.notUpdated?.[existing.id];
        if (err) throw new Error(setErrorMessage(err));
        await get().saveScript(null, GILBERT_SCRIPT, text, true);
        return;
      }
    }
    await get().saveScript(existing?.id ?? null, GILBERT_SCRIPT, text, true);
  },

  async saveScript(id, name, content, activate) {
    const accountId = get().accountId!;
    /*
     * The server's own script is compiled from the rules and the away reply it
     * keeps; writing it here would be overwritten by the next compile, and the
     * person would be told a change was saved that is not there. A script merely
     * *named* `managed` is the same lie in a second shape: the server resolves
     * that name to its own script, so the include would keep pointing at the
     * compiled one while this row claimed another.
     */
    const target = id ? get().scripts.find((s) => s.id === id) : null;
    if ((target && isManagedScript(target)) || isManagedScript({ name }))
      throw new Error(
        "The server compiles the “managed” script from your rules and out-of-office reply; it cannot be edited here.",
      );
    const up = await client.upload(
      accountId,
      new Blob([content], { type: "application/sieve" }),
      { type: "application/sieve" },
    );
    const args: Record<string, unknown> = { accountId };
    if (id) args.update = { [id]: { name, blobId: up.blobId } };
    else args.create = { s: { name, blobId: up.blobId } };
    if (activate) args.onSuccessActivateScript = id ?? "#s";
    const res = await client.call<SetResponse<SieveScript>>("SieveScript/set", args);
    const err = id ? res.notUpdated?.[id] : res.notCreated?.s;
    if (err) throw new Error(setErrorMessage(err));
    const newId = id ?? res.created!.s!.id;
    set((s) => ({ contents: { ...s.contents, [newId]: content } }));
    await get().load();
    return newId;
  },

  async activate(id) {
    const accountId = get().accountId!;
    const args: Record<string, unknown> = { accountId };
    if (id) args.onSuccessActivateScript = id;
    else args.onSuccessDeactivateScript = true;
    // A no-op set with activation hooks.
    await client.call<SetResponse>("SieveScript/set", args);
    await get().load();
  },

  async destroy(id) {
    const accountId = get().accountId!;
    const script = get().scripts.find((s) => s.id === id);
    if (script && isManagedScript(script))
      throw new Error(
        "The server compiles the “managed” script from your rules and out-of-office reply; it cannot be deleted here.",
      );
    /*
     * A server that answers `sieveIsActive` refuses to destroy the script it is
     * running. Deactivating first is the same outcome on every version, and it
     * is the step the refusal names.
     */
    if (script?.isActive) await get().activate(null);
    const res = await client.call<SetResponse>("SieveScript/set", {
      accountId,
      destroy: [id],
    });
    const err = res.notDestroyed?.[id];
    if (err) throw new Error(setErrorMessage(err));
    await get().load();
  },

  async validate(content) {
    const accountId = get().accountId!;
    try {
      const up = await client.upload(
        accountId,
        new Blob([content], { type: "application/sieve" }),
        { type: "application/sieve" },
      );
      const res = await client.call<{
        error: { type: string; description?: string } | null;
      }>("SieveScript/validate", { accountId, blobId: up.blobId });
      return res.error ? (res.error.description ?? res.error.type) : null;
    } catch (err) {
      return errorMessage(err);
    }
  },

  applyChanges(types) {
    if (types.has("SieveScript")) void get().load();
  },
}));

/**
 * Keep the server's own script in play on Stalwart 1.2.
 *
 * 1.2 compiles a person's server-side rules and away reply into a read-only
 * script named `managed`, which runs only while it is the active script or the
 * active script includes it. A filter script written before that version
 * carries no include, so activating it silently disabled the server's rules and
 * away reply. One write, on the first read that finds the gap, adds the line:
 * the rules are re-serialized from the text already there, so nothing is lost.
 * A hand-written script is left alone — it is not ours to rewrite.
 */
const repairTried = new Set<string>();

async function adoptManaged(get: () => SieveState): Promise<void> {
  const { scripts, contents } = get();
  // An older server has no such script, and naming one would fail to compile.
  if (!scripts.some(isManagedScript)) return;
  const ours = scripts.find((s) => s.name === GILBERT_SCRIPT);
  if (!ours?.isActive) return;
  const content = contents[ours.id];
  if (content === undefined || content.includes(MANAGED_INCLUDE)) return;
  const rules = sieveToRules(content);
  if (rules === null) return;
  /*
   * Once per script and session: the repair ends in a reload, and a server
   * whose answer did not keep the line would otherwise write it on every read.
   */
  const key = `${get().accountId}:${ours.id}`;
  if (repairTried.has(key)) return;
  repairTried.add(key);
  await get().saveScript(
    ours.id,
    GILBERT_SCRIPT,
    rulesToSieve(rules, { includeManaged: true }),
    false,
  );
}

/*
 * A session ending drops the scripts and the content read for them.
 *
 * A script's text belongs to the account it was read from: left in the store,
 * a second reader's session can show it and `saveScript` can write from it.
 * The account id goes too, so the next `init` sees a change and starts clean
 * whatever this left behind.
 */
useSession.subscribe((s, prev) => {
  if (s.status === "authenticated" || prev.status !== "authenticated") return;
  repairTried.clear();
  useSieve.setState({
    accountId: null,
    available: false,
    scripts: [],
    contents: {},
    loading: false,
    error: null,
  });
});
