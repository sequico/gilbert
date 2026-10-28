// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import type { VacationResponse } from "@/jmap/types";
import { useMail } from "@/store/mail";

/**
 * Reading an account's out-of-office response.
 *
 * `vacation: null` means the server answered that there is none. A read that
 * **failed** is a different answer, and it used to be dressed as that one: the
 * settings page seeds its form from `vacation` and draws nothing when there is
 * none, so an account answering everybody with a message was shown as an "off"
 * form with empty fields — and that form's Save writes the emptiness over what
 * the account is really doing. `vacationError` is what says the difference.
 */
describe("reading the out-of-office response", () => {
  const response: VacationResponse = {
    id: "singleton",
    isEnabled: true,
    subject: "Away",
    textBody: "Back on Monday.",
    htmlBody: null,
    fromDate: null,
    toDate: null,
  };

  beforeEach(() => {
    useMail.setState({ accountId: "a1", vacation: null, vacationError: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps what the server answered, and clears the failure", async () => {
    vi.spyOn(client, "call").mockResolvedValue({ list: [response] });
    await useMail.getState().loadVacation();
    expect(useMail.getState().vacation).toEqual(response);
    expect(useMail.getState().vacationError).toBeNull();
  });

  it("says it could not read rather than answering that nothing is set", async () => {
    vi.spyOn(client, "call").mockRejectedValue(new Error("the mail server is down"));
    await useMail.getState().loadVacation();
    expect(useMail.getState().vacation).toBeNull();
    expect(useMail.getState().vacationError).toContain("down");
  });

  it("does not overwrite a response it had already read", async () => {
    // A second read that fails must not turn a known "on" into an unknown, nor
    // into "off": the page keeps drawing what it knows and says the read failed.
    useMail.setState({ vacation: response, vacationError: null });
    vi.spyOn(client, "call").mockRejectedValue(new Error("the mail server is down"));
    await useMail.getState().loadVacation();
    expect(useMail.getState().vacation).toEqual(response);
    expect(useMail.getState().vacationError).toContain("down");
  });
});
