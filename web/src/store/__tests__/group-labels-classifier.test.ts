import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import type { MailAccountInfo } from "@/lib/mailAccounts";
import { labelsForAccount, useGroupLabels } from "@/store/groupLabels";
import { useMail } from "@/store/mail";
import type { Label } from "@/store/settings";

/**
 * Which accounts get a group label catalog.
 *
 * The catalog is a `labels.json` in the group account's own app folder, and
 * reading it creates the `gilbert` folder tree when it is missing. Deciding
 * "is a group" with "any account that is not mine" would do that in the
 * account of somebody who shared a calendar or a book with the reader --
 * writing into another person's storage -- and it is a second, wider
 * classifier than the one every other group surface uses: the mail store's
 * probe (`mailAccounts`, `kind: "group"`).
 */

const OWN: MailAccountInfo = { accountId: "own", name: "me@example.org", kind: "own" };
const GROUP: MailAccountInfo = {
  accountId: "gg",
  name: "team@example.org",
  kind: "group",
};

const TEAM: Label[] = [{ keyword: "$label1", name: "Team", color: "#ff0000" }];
const NOT_OURS: Label[] = [{ keyword: "$label7", name: "Not ours", color: "#0000ff" }];
const PERSONAL: Label[] = [{ keyword: "$label9", name: "Mine", color: "#00ff00" }];

beforeEach(() => {
  vi.restoreAllMocks();
  useMail.setState({
    accountId: "shared",
    ownAccountId: "own",
    mailAccounts: [OWN],
  });
  useGroupLabels.setState({
    byAccount: { gg: TEAM, shared: NOT_OURS },
    loading: {},
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useGroupLabels.setState({ byAccount: {}, loading: {} });
  useMail.setState({ accountId: null, ownAccountId: null, mailAccounts: [] });
});

describe("labelsForAccount", () => {
  it("gives an account the mail probe did not answer for the reader's own labels", () => {
    // "Not mine" is not "the group's": another person's account is not a
    // catalog this client may read, let alone write.
    expect(labelsForAccount("shared", PERSONAL)).toEqual(PERSONAL);
  });

  it("gives a probed group mailbox its own catalog", () => {
    useMail.setState({ mailAccounts: [OWN, GROUP] });
    expect(labelsForAccount("gg", PERSONAL)).toEqual(TEAM);
  });

  it("gives the reader's own mailbox their personal labels", () => {
    expect(labelsForAccount("own", PERSONAL)).toEqual(PERSONAL);
  });
});

describe("loading a group catalog", () => {
  it("creates no app folder in an account that is not a probed group", async () => {
    const chain = vi.spyOn(client, "chain").mockResolvedValue(new Map());
    const call = vi.spyOn(client, "call").mockResolvedValue({} as never);

    await useGroupLabels.getState().load("shared");

    // Reaching the catalog means `ensureFolder`, which creates the `gilbert`
    // folder tree in whatever account it is handed.
    expect(chain).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("still reaches the read for a probed group mailbox", async () => {
    useMail.setState({ mailAccounts: [OWN, GROUP] });
    const empty = () =>
      new Map<string, Record<string, unknown>[]>([
        ["q", [{ accountId: "gg", ids: [], total: 0 }]],
        ["g", [{ accountId: "gg", state: "1", list: [], notFound: [] }]],
      ]);
    const chain = vi.spyOn(client, "chain").mockImplementation(async () => empty());
    // No `gilbert` folder yet: the read is what creates it, and for a probed
    // group that is the intent (membership is the grant).
    const call = vi.spyOn(client, "call").mockResolvedValue({
      accountId: "gg",
      created: { d: { id: "af" } },
    } as never);

    await useGroupLabels.getState().load("gg");

    expect(chain).toHaveBeenCalled();
    expect(call).toHaveBeenCalled();
    expect(useGroupLabels.getState().loading.gg).toBe(false);
  });
});
