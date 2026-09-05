import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attestDarwinGitExecutable, resolveDarwinGitExecutable } from "./darwin-git.js";

describe("Darwin Git executable attestation", () => {
  it("rejects an executable under a user-writable developer-tool path", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-user-xcode-"));
    const executable = join(root, "git");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    chmodSync(root, 0o777);
    try {
      expect(() => attestDarwinGitExecutable(executable)).toThrow(
        "runtime-gateway-git-untrusted",
      );
    } finally {
      chmodSync(root, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "darwin")(
    "resolves one root-owned Git implementation through the protected system launcher",
    () => {
      const attested = resolveDarwinGitExecutable();
      expect(attested.path).toMatch(/^\/(?:Applications|Library|usr)\//u);
      expect(attested.sha256).toMatch(/^[a-f0-9]{64}$/u);
    },
  );
});
