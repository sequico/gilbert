import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkorders } from "@/store/workorder";

/*
 * The workorder panel's one read, against two races it must survive.
 *
 * A read that started before a mutation the route has since accepted must not
 * put the older summary back, and a manual refresh asked for while a read is
 * running must still land a fresh read rather than being dropped.
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
