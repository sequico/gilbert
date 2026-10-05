import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadFile } from "../download";

/**
 * A file the app made, handed to the browser to save.
 *
 * The object URL has to be released once the download has been started: a click
 * on the link starts it synchronously, and an unreleased URL keeps the whole
 * file in memory for as long as the tab is open. Five of these had been written
 * by hand and three of them never released anything, which is invisible — the
 * cost is memory in proportion to what was exported, not an error.
 */

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("downloadFile", () => {
  it("hands the browser a link with the filename and the type, and clicks it", () => {
    const created: Blob[] = [];
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
      created.push(b as Blob);
      return "blob:test";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicks.push(this);
      });

    downloadFile("cards", "text/vcard", "contacts.vcf");

    expect(click).toHaveBeenCalledTimes(1);
    expect(clicks[0]!.download).toBe("contacts.vcf");
    expect(clicks[0]!.getAttribute("href")).toBe("blob:test");
    expect(created[0]!.type).toBe("text/vcard");
  });

  it("releases the URL, so nothing stays in memory", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    downloadFile("x", "text/plain", "x.txt");

    expect(revoke).toHaveBeenCalledWith("blob:test");
  });

  it("releases it even though the link is not in the document", () => {
    // A detached anchor is what every caller uses, and a release that depended
    // on the element being attached would never run.
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    downloadFile("x", "text/plain", "x.txt");
    expect(document.querySelector("a")).toBeNull();
    expect(revoke).toHaveBeenCalled();
  });
});
