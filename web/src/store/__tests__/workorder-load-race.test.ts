import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMail } from "@/store/mail";
import { useWorkorders } from "@/store/workorder";

/*
 * The workorder panel's one read, against two races it must survive, the open
 * that re-reads it, and the FileNode change that re-reads it too.
 *
 * A read that started before a mutation the route has since accepted must not
 * put the older summary back, and a manual refresh asked for while a read is
 * running must still land a fresh read rather than being dropped. The rail
 * carries no payload, so a change on it is answered by this same read — while
 * the panel is open, and only for an account the surface follows.
 */

const summary = (uid: string, name: string) => ({ uid, name }) as never;

const respond = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

const isList = (url: string, init: RequestInit) =>
  url.endsWith("/api/workorders") && !init.method;

beforeEach(() => {
  useWorkorders.getState().reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useMail.setState({ mailAccounts: [] });
});

describe("a workorder read that races a mutation", () => {
  it("keeps the mutation's answer over the read it started before", async () => {
    const releases: Array<() => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (isList(url, init))
          return await new Promise<Response>((resolve) => {
            releases.push(() =>
              resolve(respond({ ok: true, workorders: [summary("w1", "old")] })),
            );
          });
        if (url.includes("/api/workorders/check"))
          return respond({ ok: true, workorder: summary("w1", "new") });
        return respond({ ok: true });
      }),
    );
    useWorkorders.setState({
      workorders: [],
      loaded: false,
      loading: false,
      error: null,
    });

    const loading = useWorkorders.getState().load();
    await vi.waitFor(() => expect(releases).toHaveLength(1));

    // The route accepts a check while the read is still in flight.
    await useWorkorders.getState().check("w1", "group", null, "p", "done" as never);

    releases[0]!();
    await loading;

    expect(useWorkorders.getState().workorders.find((w) => w.uid === "w1")?.name).toBe(
      "new",
    );
  });

  it("runs a refresh that was asked for while a read was running", async () => {
    let gets = 0;
    const releases: Array<() => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (isList(url, init)) {
          gets += 1;
          if (gets === 1) await new Promise<void>((r) => releases.push(r));
          return respond({
            ok: true,
            workorders:
              gets === 1
                ? [summary("w1", "old")]
                : [summary("w1", "old"), summary("w2", "second")],
          });
        }
        return respond({ ok: true });
      }),
    );
    useWorkorders.setState({
      workorders: [],
      loaded: false,
      loading: false,
      error: null,
    });

    const first = useWorkorders.getState().load();
    await vi.waitFor(() => expect(releases).toHaveLength(1));

    // The manual refresh lands while the first read is still in flight.
    await useWorkorders.getState().load();

    releases[0]!();
    await first;

    await vi.waitFor(() =>
      expect(useWorkorders.getState().workorders.some((w) => w.uid === "w2")).toBe(true),
    );
    expect(useWorkorders.getState().loading).toBe(false);
  });
});

describe("the panel's open", () => {
  it("re-reads the list on every open, not only the first", async () => {
    /*
     * The rail only fires while the panel is open, so a change that landed while
     * it was closed is picked up by the open itself: an open that reused what
     * was held would leave a member looking at a list that does not have their
     * workorder on it. Fails if `openPanel` goes back to loading only when
     * nothing is held.
     */
    let gets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (isList(url, init)) {
          gets += 1;
          return respond({ ok: true, workorders: [summary(`w${gets}`, "listed")] });
        }
        return respond({ ok: true });
      }),
    );
    useWorkorders.setState({
      workorders: [],
      loaded: false,
      loading: false,
      error: null,
    });

    useWorkorders.getState().openPanel();
    await vi.waitFor(() => expect(useWorkorders.getState().loaded).toBe(true));
    expect(gets).toBe(1);

    // A second open re-reads and takes the answer the route serves now.
    useWorkorders.getState().closePanel();
    useWorkorders.getState().openPanel();
    await vi.waitFor(() =>
      expect(useWorkorders.getState().workorders.some((w) => w.uid === "w2")).toBe(true),
    );
    expect(gets).toBe(2);
  });
});

describe("a FileNode change on the rail", () => {
  /** A group mailbox as the mail probe lists one. */
  const group = (accountId: string) => ({
    accountId,
    name: "team@example.org",
    kind: "group" as const,
  });

  /** A list stub that counts the reads it serves. */
  const listOnce = () => {
    let gets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (isList(url, init)) {
          gets += 1;
          return respond({ ok: true, workorders: [summary(`w${gets}`, "listed")] });
        }
        return respond({ ok: true });
      }),
    );
    return () => gets;
  };

  it("re-reads a group account the reader holds, while the panel is open", async () => {
    /*
     * A check somebody else made is a write to their group's part, and the rail
     * names that account and nothing else. The panel is where a checklist is
     * looked at, so an open panel turns the change into the read that shows it.
     * Fails if the rail is not wired, or the watch set is not the reader's own
     * groups.
     */
    const reads = listOnce();
    useMail.setState({ mailAccounts: [group("a3")] });
    useWorkorders.setState({
      workorders: [],
      loaded: true,
      loading: false,
      error: null,
      panelOpen: true,
    });

    await useWorkorders.getState().applyChanges("a3");

    expect(reads()).toBe(1);
    expect(useWorkorders.getState().workorders.some((w) => w.uid === "w1")).toBe(true);
  });

  it("does nothing while the panel is closed", async () => {
    /*
     * A group's chat and knowledge base ride the same rail, so an answer while
     * nobody is looking would read the route for every message for nothing.
     * Fails if the change is answered with the panel put away.
     */
    const reads = listOnce();
    useMail.setState({ mailAccounts: [group("a3")] });
    useWorkorders.setState({
      workorders: [],
      loaded: true,
      loading: false,
      error: null,
      panelOpen: false,
    });

    await useWorkorders.getState().applyChanges("a3");

    expect(reads()).toBe(0);
  });

  it("ignores an account this surface does not follow", async () => {
    /*
     * The reader's own mailbox and an unrelated account ride the rail too, and
     * neither says anything about a workorder. Fails if every change is answered
     * with a read.
     */
    const reads = listOnce();
    useMail.setState({ mailAccounts: [group("a3")] });
    useWorkorders.setState({
      workorders: [],
      loaded: true,
      loading: false,
      error: null,
      panelOpen: true,
    });

    await useWorkorders.getState().applyChanges("own-account");

    expect(reads()).toBe(0);
  });

  it("re-reads for an account a held part lives in, before the probe lists it", async () => {
    /*
     * The mail probe lands after boot, so the window before `mailAccounts` names
     * the groups is covered by the parts the last read held — otherwise a change
     * arriving in it is dropped. Fails if the watch set is only the probe's.
     */
    const reads = listOnce();
    useMail.setState({ mailAccounts: [] });
    useWorkorders.setState({
      workorders: [{ uid: "w9", parts: [{ accountId: "a9" }] } as never],
      loaded: true,
      loading: false,
      error: null,
      panelOpen: true,
    });

    await useWorkorders.getState().applyChanges("a9");

    expect(reads()).toBe(1);
  });
});

describe("a read that outlives its session", () => {
  it("drops its answer when the store was emptied while it was in flight", async () => {
    /*
     * The rail asks for reads more often, and a sign-out empties the store: an
     * answer that lands afterwards must not repopulate a store for a session that
     * is gone. Fails if the read applies whatever it was handed.
     */
    let release: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (isList(url, init))
          return await new Promise<Response>((resolve) => {
            release = () =>
              resolve(respond({ ok: true, workorders: [summary("w1", "late")] }));
          });
        return respond({ ok: true });
      }),
    );
    useWorkorders.setState({
      workorders: [],
      loaded: false,
      loading: false,
      error: null,
    });

    const loading = useWorkorders.getState().load();
    await vi.waitFor(() => expect(release).toBeDefined());

    // The session goes away while the read is in flight.
    useWorkorders.getState().reset();
    release!();
    await loading;

    expect(useWorkorders.getState().workorders).toEqual([]);
    expect(useWorkorders.getState().loaded).toBe(false);
  });
});
