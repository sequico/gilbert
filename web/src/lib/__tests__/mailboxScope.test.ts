import { describe, expect, it } from "vitest";
import type { Mailbox } from "@/jmap/types";
import { settingsMailboxTree as tree } from "@/lib/mailboxScope";

const mb = (id: string, name: string, role: string | null = null) =>
  ({ id, name, role, parentId: null }) as unknown as Mailbox;

const OWN = "own";
const GROUP = "group";

const ownTree: Record<string, Mailbox> = {
  i: mb("i", "Inbox", "inbox"),
  w: mb("w", "Work"),
};
const groupTree: Record<string, Mailbox> = {
  g1: mb("g1", "Team Inbox", "inbox"),
  g2: mb("g2", "Team Projects"),
};

describe("settingsMailboxTree — the folders Settings -> Folders is about", () => {
  it("is the reader's own tree while their own account is active", () => {
    expect(
      tree({
        accountTrees: { [OWN]: ownTree, [GROUP]: groupTree },
        ownAccountId: OWN,
        accountId: OWN,
        mailboxes: ownTree,
      }),
    ).toBe(ownTree);
  });

  it("is the reader's own tree while a group mailbox is the active account", () => {
    const got = tree({
      accountTrees: { [OWN]: ownTree, [GROUP]: groupTree },
      ownAccountId: OWN,
      accountId: GROUP,
      mailboxes: groupTree,
    });
    expect(got).toBe(ownTree);
    // The group's folders are in accountTrees and in the active tree; neither
    // may reach this surface.
    expect(Object.keys(got).sort()).toEqual(["i", "w"]);
    for (const m of Object.values(got)) expect(m.name.startsWith("Team ")).toBe(false);
  });

  it("contributes nothing from a group tree cached beside the own one", () => {
    const got = tree({
      accountTrees: { [OWN]: ownTree, [GROUP]: groupTree },
      ownAccountId: OWN,
      accountId: GROUP,
      mailboxes: groupTree,
    });
    expect(Object.values(got)).not.toContain(groupTree.g1);
    expect(Object.values(got)).not.toContain(groupTree.g2);
  });

  it("is empty when no own tree is cached", () => {
    expect(
      tree({
        accountTrees: { [GROUP]: groupTree },
        ownAccountId: OWN,
        accountId: OWN,
        mailboxes: ownTree,
      }),
    ).toEqual({});
  });

  it("reads no other account's cache entry when the own one is missing", () => {
    // The group's tree is the only one cached, and the active one besides;
    // with nothing under the own account id there is nothing to show here.
    expect(
      tree({
        accountTrees: { [GROUP]: groupTree },
        ownAccountId: OWN,
        accountId: GROUP,
        mailboxes: groupTree,
      }),
    ).toEqual({});
  });

  it("falls back to the active tree only when it is the reader's own account", () => {
    expect(
      tree({
        accountTrees: {},
        ownAccountId: null,
        accountId: null,
        mailboxes: ownTree,
      }),
    ).toBe(ownTree);
    expect(
      tree({
        accountTrees: { [GROUP]: groupTree },
        ownAccountId: null,
        accountId: GROUP,
        mailboxes: groupTree,
      }),
    ).toEqual({});
  });
});
