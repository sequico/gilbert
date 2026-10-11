import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import { useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";
import { toast } from "@/ui/toast";

/**
 * What happens to a message whose send fails.
 *
 * Send hides the composer and submits after the undo window, so a failure used
 * to leave the draft nowhere until somebody clicked the toast action -- and the
 * toast is gone in fifteen or thirty seconds. A message composed and sent in a
 * moment could be lost by not looking. The draft is put back on the failure
 * itself now; the toast is a notice, not the only way back.
 *
 * The second failure this covers is the attachment still uploading when Send
 * is pressed: its upload lands after the draft left `drafts`, and the upload's
 * blob has to reach the snapshot a failure restores, or every later Send
 * refuses the draft as "Attachments are still uploading".
 */

const jane = { id: "i1", name: "John", email: "john@example.org", replyTo: null };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
  useCompose.setState({ drafts: [], activeKey: null, pendingSends: {} });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  useMail.setState({
    accountId: "a1",
    identities: [jane] as never,
    mailboxes: {
      mb1: { id: "mb1", name: "Sent", role: "sent" },
      mb2: { id: "mb2", name: "Drafts", role: "drafts" },
    } as never,
    list: null,
    loadMailboxes: (async () => undefined) as never,
    refreshList: (async () => undefined) as never,
  });
  vi.spyOn(client, "chain").mockRejectedValue(new Error("server down"));
  vi.spyOn(client, "call").mockImplementation(async (method) => {
    if (method === "Email/query" || method === "EmailSubmission/query")
      return { accountId: "a1", ids: [] } as never;
    return { accountId: "a1" } as never;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A draft ready to send, keyed for the store. */
function openDraft(): string {
  return useCompose.getState().open({
    identityId: "i1",
    to: [{ name: null, email: "ann@example.com" }],
    subject: "Hi",
    html: "<div>v1</div>",
    text: "v1",
  });
}

/** Let the awaits inside the send settle while the clock is faked. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

describe("a send that fails", () => {
  it("puts the draft back by itself, not only when the toast is clicked", async () => {
    const key = openDraft();
    const error = vi.spyOn(toast, "error").mockReturnValue(1);

    void useCompose.getState().send(key);
    // Send hides the composer at once; the message fails after the window.
    expect(useCompose.getState().drafts.some((d) => d.key === key)).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);
    await settle();

    expect(useCompose.getState().drafts.some((d) => d.key === key)).toBe(true);
    expect(error).toHaveBeenCalled();
  });
});

describe("an attachment still uploading when Send is pressed", () => {
  it("keeps its uploaded blob in the draft a failed send restores", async () => {
    const key = openDraft();
    let resolveUpload!: (v: { blobId: string; type: string; size: number }) => void;
    const upload = new Promise<{ blobId: string; type: string; size: number }>((res) => {
      resolveUpload = res;
    });
    vi.spyOn(client, "upload").mockReturnValue(upload as never);
    useCompose
      .getState()
      .addFiles(key, [new File(["x"], "a.txt", { type: "text/plain" })]);

    void useCompose.getState().send(key);
    // The upload lands after the draft has left `drafts`.
    resolveUpload({ blobId: "b1", type: "text/plain", size: 1 });
    await settle();

    // The snapshot the send is holding carries the blob, which is what the
    // failure restores.
    expect(useCompose.getState().pendingSends[key]?.draft.attachments[0]?.blobId).toBe(
      "b1",
    );

    await vi.advanceTimersByTimeAsync(5000);
    await settle();

    const restored = useCompose.getState().drafts.find((d) => d.key === key);
    expect(restored?.attachments[0]?.blobId).toBe("b1");
  });
});
