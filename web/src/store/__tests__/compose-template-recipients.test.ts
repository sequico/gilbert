import { beforeEach, describe, expect, it } from "vitest";
import { useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";

/**
 * A template that remembers who it is for. What has to hold: the recipients it
 * carries join the ones already on the message (never appearing twice, in any
 * field), the placeholders are filled against them so "Dear
 * {{recipientFirstName}}" names the person the template is for, and a template
 * saved before recipients existed inserts exactly as it did.
 */

const IDENTITY = { id: "i1", name: "John", email: "john@example.org", replyTo: null };

beforeEach(() => {
  useMail.setState({
    accountId: "a1",
    identities: [IDENTITY] as never,
    defaultIdentity: (() => IDENTITY) as never,
  });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  useCompose.setState({ drafts: [], activeKey: null, pendingSends: {} });
});

const draftFor = (key: string) =>
  useCompose.getState().drafts.find((d) => d.key === key)!;

describe("inserting a template that remembers its recipients", () => {
  it("adds them beside the ones already there, and opens the rows it fills", () => {
    const key = useCompose.getState().open({
      to: [{ name: "Ann", email: "ann@example.com" }],
    });
    useCompose.getState().insertTemplate(key, {
      html: "<p>Hi</p>",
      subject: "Invoice",
      to: [
        { name: "Ann", email: "ann@example.com" },
        { name: "Bob", email: "bob@example.com" },
      ],
      cc: [{ name: null, email: "desk@example.com" }],
      bcc: [{ name: null, email: "file@example.com" }],
    });

    const d = draftFor(key);
    expect(d.to.map((a) => a.email)).toEqual(["ann@example.com", "bob@example.com"]);
    expect(d.cc.map((a) => a.email)).toEqual(["desk@example.com"]);
    expect(d.bcc.map((a) => a.email)).toEqual(["file@example.com"]);
    expect(d.showCc).toBe(true);
    expect(d.showBcc).toBe(true);
  });

  it("does not add an address already on the message in another field", () => {
    const key = useCompose.getState().open({
      cc: [{ name: "Ann", email: "ann@example.com" }],
    });
    useCompose.getState().insertTemplate(key, {
      html: "<p>Hi</p>",
      to: [{ name: "Ann", email: "ann@example.com" }],
    });

    const d = draftFor(key);
    expect(d.to).toEqual([]);
    expect(d.cc.map((a) => a.email)).toEqual(["ann@example.com"]);
  });

  it("fills the placeholders against the template's own recipients", () => {
    const key = useCompose.getState().open();
    useCompose.getState().insertTemplate(key, {
      html: "<p>Dear {{recipientFirstName}}</p>",
      to: [{ name: "Bob Smith", email: "bob@example.com" }],
    });

    expect(draftFor(key).html).toContain("Dear Bob");
  });

  it("inserts a template saved without recipients exactly as before", () => {
    const key = useCompose.getState().open();
    const before = draftFor(key);
    useCompose.getState().insertTemplate(key, { html: "<p>Hi</p>", subject: "Hello" });

    const d = draftFor(key);
    expect(d.to).toEqual(before.to);
    expect(d.cc).toEqual(before.cc);
    expect(d.bcc).toEqual(before.bcc);
    expect(d.subject).toBe("Hello");
  });
});
