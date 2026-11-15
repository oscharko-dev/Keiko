import { describe, expect, it } from "vitest";
import { readMacosKeychainSecret, writeMacosKeychainSecret } from "./macos-keychain.js";
import {
  inheritWindowsParentDacl,
  inspectWindowsOwnerPrivateFiles,
  protectWindowsOwnerPrivateFile,
} from "./windows-owner-private.js";
import { readWindowsProcessCommandLine } from "./windows-process-identity.js";

// #4351: a caller that named no sink lost its Activity Log line as an unwired port and made every
// support export read "degraded". The sink is a required field at these entry points, so a caller
// without one no longer compiles. Each directive below stops being valid, and the typecheck fails,
// the day a sink becomes optional here again. The function is never run.
describe("the log sink is required at the entry points the server and the CLI call (#4351)", () => {
  it("rejects a call that names no sink at compile time", () => {
    const callsWithoutASink = (): void => {
      // @ts-expect-error a keychain read without a sink loses its withheld and fallback lines
      readMacosKeychainSecret("svc", "acct", { platform: "darwin" });
      // @ts-expect-error a keychain write without a sink loses its withheld and fallback lines
      writeMacosKeychainSecret("svc", "acct", "value", { platform: "darwin" });
      // @ts-expect-error the DACL tool needs its options and with them a sink
      protectWindowsOwnerPrivateFile("path");
      // @ts-expect-error options without a sink are refused
      protectWindowsOwnerPrivateFile("path", {});
      // @ts-expect-error options without a sink are refused
      inheritWindowsParentDacl("path", {});
      // @ts-expect-error options without a sink are refused
      inspectWindowsOwnerPrivateFiles(["path"], {});
      // @ts-expect-error options without a sink are refused
      readWindowsProcessCommandLine(1, {});
    };
    expect(typeof callsWithoutASink).toBe("function");
  });
});
