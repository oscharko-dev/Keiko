// #4358: the launcher's root policy acts on the Windows local-volume verdict at setup and launch.
// It asks Windows every time and can never reach the pass a passive read may remember.
import { afterEach, describe, expect, it, vi } from "vitest";

const volumeCheck = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@oscharko-dev/keiko-security/windows-local-volume", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@oscharko-dev/keiko-security/windows-local-volume")>();
  return {
    ...actual,
    assertWindowsLocalVolume: (): void => {
      volumeCheck.calls.push("enforcing");
    },
    assertWindowsLocalVolumeForPassiveRead: (): void => {
      volumeCheck.calls.push("passive-read");
    },
  };
});

import { assertManagedRootAllowed } from "./portable-root-policy.js";

afterEach(() => {
  volumeCheck.calls.length = 0;
});

describe("the launcher's root policy and the local-volume check", () => {
  it("asks Windows on every call and never for a remembered pass", () => {
    // A user-local root that exists on no test host: the policy's earlier rules accept it without
    // touching the file system, so the volume check is reached.
    const managed = "/Users/keiko/AppData/Local/Programs/Keiko";
    const state = "/Users/keiko/.keiko";
    const attempt = (): void => {
      try {
        assertManagedRootAllowed(managed, state, "windows-x64");
      } catch {
        // later rules of the policy may refuse this synthetic root; the volume check ran before them
      }
    };
    attempt();
    attempt();
    expect(volumeCheck.calls).toEqual(["enforcing", "enforcing"]);
  });
});
