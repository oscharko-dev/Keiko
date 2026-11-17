import { describe, expect, it } from "vitest";
import { hostCredentialConfigArgs } from "./network-credentials.js";

function entry(scope: string, key: string, value: string): string {
  return `${scope}\0${key}\n${value}\0`;
}

describe("protected host credential projection", () => {
  it("keeps system/global order, URL matching and empty resets", () => {
    const listing =
      entry("system", "credential.helper", "manager") +
      entry("global", "credential.helper", "") +
      entry("global", "credential.https://fixture.invalid.helper", "osxkeychain");
    expect(hostCredentialConfigArgs(listing)).toEqual([
      "-c",
      "credential.helper=manager",
      "-c",
      "credential.helper=",
      "-c",
      "credential.https://fixture.invalid.helper=osxkeychain",
    ]);
  });

  it("never promotes repository, worktree or command scope entries", () => {
    const listing = ["local", "worktree", "command", "unknown"]
      .map((scope) => entry(scope, "credential.helper", "!untrusted-command"))
      .join("");
    expect(hostCredentialConfigArgs(listing)).toEqual([]);
  });

  it("keeps a trusted helper value in one argv item without interpreting it as an option", () => {
    const helper = "!fixture-helper '-c core.fsmonitor=untrusted'";
    expect(hostCredentialConfigArgs(entry("global", "credential.helper", helper))).toEqual([
      "-c",
      `credential.helper=${helper}`,
    ]);
  });

  it.each([
    "global\0credential.helper\nmanager",
    "global\0",
    "global\0credential.helper\0",
    entry("global", "credential.helper=untrusted", "manager"),
    entry("global", "core.fsmonitor", "untrusted"),
    entry("global", "credential.https://fixture.invalid/\ncore.fsmonitor.helper", "untrusted"),
    entry("global", "credential.helper", "manager").repeat(129),
  ])("fails closed on malformed or oversized credential listings", (listing) => {
    expect(hostCredentialConfigArgs(listing)).toBeUndefined();
  });

  it("accepts an absent host configuration", () => {
    expect(hostCredentialConfigArgs("")).toEqual([]);
  });
});
