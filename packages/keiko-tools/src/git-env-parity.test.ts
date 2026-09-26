// KEIKO-0717: packages/keiko-contracts/src/tools.ts hand-maintains
// GOVERNED_GIT_REMOTE_PINNED_ENV as a mirror of keiko-git's networkGitEnv()
// (packages/keiko-git/src/env.ts) — every askpass/SSH pin the governed-git-remote sandbox lane
// applies must match what keiko-git actually computes for a real network git invocation, on every
// platform, or the two hand-maintained copies silently drift (e.g. GIT_ASKPASS pinned to the POSIX
// null device even when the host is Windows, where the null device is `NUL`, not `/dev/null`).
//
// keiko-contracts is the ADR-0019 leaf package and must not import keiko-git (direction-1), so this
// parity check lives here in keiko-tools, which already depends on both packages.
import { afterEach, describe, expect, it, vi } from "vitest";
import { networkGitEnv } from "@oscharko-dev/keiko-git";

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});

// keiko-git's networkGitEnv() reads process.platform at CALL time (via its own devNullPath default
// parameter), so a plain static import can be re-invoked after flipping the platform. keiko-
// contracts' GOVERNED_GIT_REMOTE_PINNED_ENV is a frozen constant evaluated once at module load, so
// getting an independent win32 snapshot requires resetting the module registry and re-importing
// fresh under the simulated platform — the same technique
// packages/keiko-security/src/fs-hardening.test.ts uses for its own platform-dependent module-level
// behaviour.
async function loadPinnedEnv(platform: NodeJS.Platform): Promise<Readonly<Record<string, string>>> {
  vi.resetModules();
  setPlatform(platform);
  const contracts = await import("@oscharko-dev/keiko-contracts/runtime/tools");
  return contracts.GOVERNED_GIT_REMOTE_PINNED_ENV;
}

// Only the keys GOVERNED_GIT_REMOTE_PINNED_ENV itself declares are in scope: keiko-git's
// networkGitEnv() additionally sets GIT_CONFIG_NOSYSTEM/GIT_OPTIONAL_LOCKS and passes through
// account/agent state (PATH, HOME, SSH_AUTH_SOCK, ...) that the pinned table never declares — see
// tools.ts's own comment for why GIT_CONFIG_NOSYSTEM is deliberately absent there. Every key the
// pinned table DOES declare must still resolve to the identical value keiko-git computes.
function assertParity(
  pinnedEnv: Readonly<Record<string, string>>,
  referenceEnv: NodeJS.ProcessEnv,
): void {
  const pinnedKeys = Object.keys(pinnedEnv);
  expect(pinnedKeys.length).toBeGreaterThan(0);
  for (const key of pinnedKeys) {
    expect(
      referenceEnv[key],
      `pinned key ${key} has drifted from keiko-git's networkGitEnv()`,
    ).toBe(pinnedEnv[key]);
  }
}

describe("GOVERNED_GIT_REMOTE_PINNED_ENV / networkGitEnv parity (KEIKO-0717)", () => {
  it("matches keiko-git's networkGitEnv() on POSIX", async () => {
    const pinnedEnv = await loadPinnedEnv("linux");
    assertParity(pinnedEnv, networkGitEnv({ PATH: "/usr/bin" }));
  });

  it("matches keiko-git's networkGitEnv() on win32", async () => {
    const pinnedEnv = await loadPinnedEnv("win32");
    assertParity(pinnedEnv, networkGitEnv({ PATH: "C:\\Git\\bin" }));
  });
});
