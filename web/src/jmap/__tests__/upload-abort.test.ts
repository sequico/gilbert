import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";

/**
 * `upload()` and its abort signal (finding 12).
 *
 * A caller that changed its mind before the bytes went was still uploading;
 * and the abort listener stayed on the signal for the life of the page. An
 * already-aborted signal rejects like `request` does, and every terminal
 * handler detaches the listener.
 */

class FakeXHR {
  static last: FakeXHR | null = null;
  method = "";
  url = "";
  sent = false;
  aborted = 0;
  responseType = "";
  status = 0;
  response: unknown = null;
  upload: {
    onprogress:
      | ((e: { lengthComputable: boolean; loaded: number; total: number }) => void)
      | null;
  } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXHR.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader() {}
  send() {
    this.sent = true;
  }
  abort() {
    this.aborted++;
  }
  addEventListener() {}
  removeEventListener() {}
}

const blob = () => new Blob(["x"], { type: "text/plain" });

describe("upload() and its abort signal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeXHR.last = null;
  });

  it("rejects an already-aborted signal without sending", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    const controller = new AbortController();
    controller.abort();

    const p = client.upload("acc", blob(), { signal: controller.signal });

    await expect(p).rejects.toMatchObject({ code: "aborted" });
    // Nothing was constructed, so no bytes were ever sent.
    expect(FakeXHR.last).toBeNull();
  });

  it("detaches its listener once the upload settles", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    const controller = new AbortController();

    const p = client.upload("acc", blob(), { signal: controller.signal });
    const xhr = FakeXHR.last!;

    xhr.status = 200;
    xhr.response = { accountId: "acc", blobId: "b1", type: "text/plain", size: 1 };
    xhr.onload?.();
    await expect(p).resolves.toMatchObject({ blobId: "b1" });

    // The signal no longer reaches the settled request.
    controller.abort();
    expect(xhr.aborted).toBe(0);
  });

  it("aborts the request mid-flight and rejects as aborted", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    const controller = new AbortController();

    const p = client.upload("acc", blob(), { signal: controller.signal });
    const xhr = FakeXHR.last!;

    controller.abort();
    expect(xhr.aborted).toBe(1);
    xhr.onabort?.();
    await expect(p).rejects.toMatchObject({ code: "aborted" });
  });
});
