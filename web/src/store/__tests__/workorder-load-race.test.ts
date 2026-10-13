import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkorders } from "@/store/workorder";

/*
 * The workorder panel's one read, against two races it must survive, and the
 * open that re-reads it.
 *
 * A read that started before a mutation the route has since accepted must not
 * put the older summary back, and a manual refresh asked for while a read is
 * running must still land a fresh read rather than being dropped. An open
 * re-reads, because this surface has no push rail: a step somebody else checked,
 * or a workorder an administrator created, is heard about only by asking.
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
     * There is no push rail on this surface: a check somebody else made, or a
     * workorder an administrator created, reaches an open panel only through a
     * read. An open that reused what was held would leave a member looking at a
     * list that does not have their workorder on it. Fails if `openPanel` goes
     * back to loading only when nothing is held.
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
