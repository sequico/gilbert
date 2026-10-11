import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, client } from "@/jmap/client";
import { useMail } from "@/store/mail";

/**
 * A `Email/changes` pass that keeps failing is said once, not swallowed.
 *
 * A transient failure is left alone: the token does not move, so the next pass
 * asks for the same window again and heals itself. A pass that keeps failing
 * is a different thing -- the list has stopped updating -- and it is reported
 * once for the outage rather than on every push beat.
 */

const changes = (over: Record<string, unknown> = {}) => ({
  created: [],
  updated: [],
  destroyed: [],
  newState: "s1",
  hasMoreChanges: false,
  ...over,
});

/** The server's answer to everything but `Email/changes`, which `mode` drives. */
function server(mode: () => Record<string, unknown>) {
  vi.spyOn(client, "call").mockImplementation((async (method: string) => {
    if (method === "Email/changes") return mode();
    if (method === "Mailbox/get") return { list: [], state: "m1" };
    return { list: [], state: "s1", notFound: [] };
  }) as never);
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  useMail.setState({
    accountId: "a1",
    emailState: "s0",
    emails: {},
    fullIds: {},
    threads: {},
    list: null,
    openThreadId: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useMail.setState({ emailState: null, list: null });
});

describe("a mail change pass that fails", () => {
  it("is reported once while it persists, and again after a pass lands", async () => {
    let failing = true;
    server(() => {
      if (failing) throw new ApiError(500, "serverFail");
      return changes();
    });

    await useMail.getState().applyChanges(new Set(["Email"]));
    await useMail.getState().applyChanges(new Set(["Email"]));
    // Two consecutive failures are one message, not two.
    expect(warn).toHaveBeenCalledTimes(1);

    // A pass that lands answers the outage...
    failing = false;
    await useMail.getState().applyChanges(new Set(["Email"]));
    expect(warn).toHaveBeenCalledTimes(1);

    // ...so a later failure is news again.
    failing = true;
    await useMail.getState().applyChanges(new Set(["Email"]));
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
