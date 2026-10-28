// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mayAdminister } from "@/lib/administer";

/**
 * Who may administer, as every surface must read it (ADR 0015).
 *
 * The session carries two facts — the Stalwart admin marker and whether this
 * installation lets this session administer at all — and a surface that reads
 * only the first draws controls the door refuses. The menu and the workorder
 * panel's create/close controls both go through this, which is what keeps them
 * agreeing.
 *
 * It deliberately says nothing about *checking* a workorder's steps: that is
 * competence (per-part `canCheck`), and a member keeps it whatever this returns.
 */
describe("mayAdminister", () => {
  it("is true for an administrator on an installation that allows it", () => {
    expect(mayAdminister({ isAdmin: true } as never)).toBe(true);
    expect(mayAdminister({ isAdmin: true, administration: true } as never)).toBe(true);
  });

  it("is false for a member", () => {
    expect(mayAdminister({ isAdmin: false, administration: true } as never)).toBe(false);
    expect(mayAdminister(undefined)).toBe(false);
  });

  it("is false when the installation or the device refuses it", () => {
    // `administration` names the door: false is the installation saying no, or
    // the session not being on a device its person marked as their own.
    expect(mayAdminister({ isAdmin: true, administration: false } as never)).toBe(false);
  });
});
