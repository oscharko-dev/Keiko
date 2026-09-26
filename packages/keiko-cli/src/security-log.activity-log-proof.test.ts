// Activity Log proofs for the eight `security.windows-*.system-{root-refused,binary-missing}`
// operations (#3532 proof backlog, partition p4-cli). All eight share the two private emitters
// `emitWindowsSystemRootRefusal` / `emitWindowsSystemBinaryMissing`, dispatched by surface through
// the one exported entry point `emitCliWindowsSystemFailure`. Driving that entry point with each of
// the two typed keiko-security errors, across all four surfaces, reaches every one of the eight
// registered operations without reimplementing the dispatch.
//
// Each proof id is a literal argument at its own `expectActivityLogProof` call site — the
// op-catalog generator resolves proofs by parsing that literal, so a table- or loop-driven id (an
// `it.each` case value, for example) never resolves even though it holds the right string at
// runtime. `driveRootRefused`/`driveBinaryMissing` below only do the drive-and-capture work; the
// literal id and its assertions stay in each `it` block.
import { describe, expect, it } from "vitest";
import {
  WindowsSystemBinaryMissingError,
  WindowsSystemDirectoryError,
  type SecurityLogEvent,
} from "@oscharko-dev/keiko-security";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { emitCliWindowsSystemFailure, type CliWindowsSystemSurface } from "./security-log.js";

function driveRootRefused(surface: CliWindowsSystemSurface): string {
  const events: SecurityLogEvent[] = [];
  const handled = emitCliWindowsSystemFailure(
    new WindowsSystemDirectoryError("Windows system directory override must be drive-absolute"),
    { write: (event): void => void events.push(event) },
    surface,
  );
  expect(handled).toBe(true);
  expect(events).toHaveLength(1);
  return formatActivityLogProofLine(events[0] ?? {});
}

function driveBinaryMissing(surface: CliWindowsSystemSurface): string {
  const events: SecurityLogEvent[] = [];
  const handled = emitCliWindowsSystemFailure(
    new WindowsSystemBinaryMissingError(),
    { write: (event): void => void events.push(event) },
    surface,
  );
  expect(handled).toBe(true);
  expect(events).toHaveLength(1);
  return formatActivityLogProofLine(events[0] ?? {});
}

describe("security-log activity log proofs", () => {
  describe("system-root-refused", () => {
    it("persists security.windows-launcher.system-root-refused", () => {
      const record = expectActivityLogProof(
        "security.windows-launcher.system-root-refused.emitted-line",
        driveRootRefused("launcher-install"),
      );
      expect(record).toMatchObject({
        surface: "launcher-install",
        failureKind: "WindowsSystemDirectoryError",
        errorKind: "unsafe-target",
        level: "warn",
      });
    });

    it("persists security.windows-portable-legacy-launcher.system-root-refused", () => {
      const record = expectActivityLogProof(
        "security.windows-portable-legacy-launcher.system-root-refused.emitted-line",
        driveRootRefused("legacy-start-menu-cleanup"),
      );
      expect(record).toMatchObject({
        surface: "legacy-start-menu-cleanup",
        failureKind: "WindowsSystemDirectoryError",
        errorKind: "unsafe-target",
        level: "warn",
      });
    });

    it("persists security.windows-portable-alert.system-root-refused", () => {
      const record = expectActivityLogProof(
        "security.windows-portable-alert.system-root-refused.emitted-line",
        driveRootRefused("portable-failure-alert"),
      );
      expect(record).toMatchObject({
        surface: "portable-failure-alert",
        failureKind: "WindowsSystemDirectoryError",
        errorKind: "unsafe-target",
        level: "warn",
      });
    });

    it("persists security.windows-lifecycle-opener.system-root-refused", () => {
      const record = expectActivityLogProof(
        "security.windows-lifecycle-opener.system-root-refused.emitted-line",
        driveRootRefused("start-open-browser"),
      );
      expect(record).toMatchObject({
        surface: "start-open-browser",
        failureKind: "WindowsSystemDirectoryError",
        errorKind: "unsafe-target",
        level: "warn",
      });
    });
  });

  describe("system-binary-missing", () => {
    it("persists security.windows-launcher.system-binary-missing", () => {
      const record = expectActivityLogProof(
        "security.windows-launcher.system-binary-missing.emitted-line",
        driveBinaryMissing("launcher-install"),
      );
      expect(record).toMatchObject({
        surface: "launcher-install",
        failureKind: "WINDOWS_SYSTEM_BINARY_MISSING",
        errorKind: "unavailable",
        level: "error",
      });
    });

    it("persists security.windows-portable-legacy-launcher.system-binary-missing", () => {
      const record = expectActivityLogProof(
        "security.windows-portable-legacy-launcher.system-binary-missing.emitted-line",
        driveBinaryMissing("legacy-start-menu-cleanup"),
      );
      expect(record).toMatchObject({
        surface: "legacy-start-menu-cleanup",
        failureKind: "WINDOWS_SYSTEM_BINARY_MISSING",
        errorKind: "unavailable",
        level: "error",
      });
    });

    it("persists security.windows-portable-alert.system-binary-missing", () => {
      const record = expectActivityLogProof(
        "security.windows-portable-alert.system-binary-missing.emitted-line",
        driveBinaryMissing("portable-failure-alert"),
      );
      expect(record).toMatchObject({
        surface: "portable-failure-alert",
        failureKind: "WINDOWS_SYSTEM_BINARY_MISSING",
        errorKind: "unavailable",
        level: "error",
      });
    });

    it("persists security.windows-lifecycle-opener.system-binary-missing", () => {
      const record = expectActivityLogProof(
        "security.windows-lifecycle-opener.system-binary-missing.emitted-line",
        driveBinaryMissing("start-open-browser"),
      );
      expect(record).toMatchObject({
        surface: "start-open-browser",
        failureKind: "WINDOWS_SYSTEM_BINARY_MISSING",
        errorKind: "unavailable",
        level: "error",
      });
    });
  });

  it("returns false and emits nothing for an error outside the trusted-Windows-path contract", () => {
    const events: SecurityLogEvent[] = [];
    const handled = emitCliWindowsSystemFailure(
      new Error("unrelated"),
      { write: (event): void => void events.push(event) },
      "launcher-install",
    );
    expect(handled).toBe(false);
    expect(events).toEqual([]);
  });
});
