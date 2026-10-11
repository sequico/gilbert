import { afterEach, describe, expect, it } from "vitest";
import type { Email } from "@/jmap/types";
import { useMail } from "@/store/mail";
import { foldersBefore, foldersChanged } from "../MailView";

/**
 * Reading back whether an archive or spam moved anything (finding 2).
 *
 * `archive` and `spam` answer nothing, so a move that did nothing -- no Archive
 * folder, no Junk Mail, no account -- was reported as a changed list and the
 * focus slid off a row that is still here. The folders each id is in are
 * compared before and after; an unchanged set is an id the action did not
 * touch.
 */

const mail = (id: string, mailboxIds: Record<string, boolean>): Email =>
  ({ id, mailboxIds }) as unknown as Email;

describe("reading a move back", () => {
  afterEach(() => {
    useMail.setState({ emails: {} });
  });

  it("says nothing changed when the folders are the same", () => {
    useMail.setState({ emails: { m1: mail("m1", { inbox: true }) } });
    const before = foldersBefore(["m1"]);
    expect(foldersChanged(before)).toBe(false);
  });

  it("says something happened when a folder was added or dropped", () => {
    useMail.setState({ emails: { m1: mail("m1", { inbox: true }) } });
    const before = foldersBefore(["m1"]);
    useMail.setState({ emails: { m1: mail("m1", { archive: true }) } });
    expect(foldersChanged(before)).toBe(true);
  });

  it("treats an id that has left the store as a change", () => {
    useMail.setState({ emails: { m1: mail("m1", { inbox: true }) } });
    const before = foldersBefore(["m1"]);
    useMail.setState({ emails: {} });
    expect(foldersChanged(before)).toBe(true);
  });
});
