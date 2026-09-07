import { describe, expect, it } from "vitest";
import { isAdminGroupAccountName } from "@/lib/mailAccounts";

describe("isAdminGroupAccountName", () => {
  it("matches the admin group on any domain", () => {
    expect(isAdminGroupAccountName("gilbert-admin@ops.example.com")).toBe(true);
    expect(isAdminGroupAccountName("gilbert-admin@other.example")).toBe(true);
  });

  it("leaves working groups and personal accounts alone", () => {
    expect(isAdminGroupAccountName("freight@ops.example.com")).toBe(false);
    expect(isAdminGroupAccountName("sam@ops.example.com")).toBe(false);
  });
});
