import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";

const assertWindowsLocalVolume = vi.hoisted(() =>
  vi.fn<(path: string, options: { readonly securityLogSink?: SecurityLogSink }) => void>(
    () => undefined,
  ),
);

vi.mock("@oscharko-dev/keiko-security/windows-local-volume", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oscharko-dev/keiko-security/windows-local-volume")>()),
  assertWindowsLocalVolume,
}));

const { assertManagedRootAllowed } = await import("./portable-root-policy.js");

// #4351: the managed-root check asks the Windows local-volume tool whether the install root is on a
// local volume, and that tool reports its refusal to a sink. Callers that named none lost the
// `windows-local-volume.refused` line. The tool itself is replaced, so the proof is the same on
// every host: the sink the caller holds is the sink the volume check receives.
describe("the managed-root policy of the portable install", () => {
  it("hands the caller's sink to the Windows local-volume check", () => {
    const securityLogSink: SecurityLogSink = { write: () => undefined };
    assertWindowsLocalVolume.mockClear();
    try {
      assertManagedRootAllowed(
        join(homedir(), "Keiko-managed-root-policy-proof"),
        join(homedir(), ".keiko-state-proof"),
        "windows-x64",
        securityLogSink,
      );
    } catch {
      // Later steps of the policy may refuse this synthetic root; only the hand-over matters.
    }
    expect(assertWindowsLocalVolume).toHaveBeenCalledWith(expect.any(String), { securityLogSink });
  });

  it("does not compile without a sink", () => {
    const withoutASink = (): void => {
      // @ts-expect-error a managed-root check without a sink loses the local-volume refusal line
      assertManagedRootAllowed("root", "state", "windows-x64");
    };
    expect(typeof withoutASink).toBe("function");
  });
});
