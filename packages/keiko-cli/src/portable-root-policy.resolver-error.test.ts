// #4358: when Windows PowerShell cannot be resolved, the local-volume check of the root policy
// must throw the resolver's own error, not a wrapper: the launcher recognises exactly these
// classes and answers "trusted Windows launch helper is unavailable" for them.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WindowsSystemBinaryMissingError,
  WindowsSystemDirectoryError,
  type SecurityLogEvent,
} from "@oscharko-dev/keiko-security";
import { windowsLocalVolumeVerdict } from "@oscharko-dev/keiko-security/windows-local-volume";
import { assertManagedRootAllowed } from "./portable-root-policy.js";
import { emitCliWindowsSystemFailure } from "./security-log.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("the root policy when Windows PowerShell cannot be resolved", () => {
  it("throws the resolver's own error, which the launcher's helper-unavailable handling matches", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    // no trusted Windows system directory on this host: the resolver refuses before any program runs
    vi.stubEnv("SystemRoot", "");
    vi.stubEnv("WINDIR", "");
    let thrown: unknown;
    try {
      assertManagedRootAllowed(
        "/Users/keiko/AppData/Local/Programs/Keiko",
        "/Users/keiko/.keiko",
        "windows-x64",
      );
    } catch (error) {
      thrown = error;
    }

    expect(
      thrown instanceof WindowsSystemDirectoryError ||
        thrown instanceof WindowsSystemBinaryMissingError,
    ).toBe(true);
    // nothing was learned about the volume
    expect(windowsLocalVolumeVerdict(thrown)).toBe("unverifiable");
    const events: SecurityLogEvent[] = [];
    const handled = emitCliWindowsSystemFailure(
      thrown,
      { write: (event): void => void events.push(event) },
      "launcher-install",
    );
    expect(handled).toBe(true);
    expect(events.map((event) => event.op)).toEqual([
      expect.stringMatching(/^security\.windows-launcher\.system-(root-refused|binary-missing)$/u),
    ]);
  });
});
