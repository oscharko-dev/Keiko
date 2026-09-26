import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attestDarwinGitExecutable,
  chooseAttestedDarwinGit,
  resolveDarwinGitExecutable,
} from "./darwin-git.js";

describe("Darwin Git executable attestation", () => {
  it("uses only an attested Command Line Tools Git when the selected Git is untrusted", () => {
    const attempted: string[] = [];
    const selected = "/untrusted/selected/git";
    const commandLineTools = "/trusted/command-line-tools/git";
    const resolved = chooseAttestedDarwinGit(
      (developerDirectory) => {
        attempted.push(developerDirectory ?? "selected");
        return developerDirectory === undefined ? selected : commandLineTools;
      },
      (path) => {
        if (path === selected) throw new Error("runtime-gateway-git-untrusted");
        return { path, sha256: "a".repeat(64) };
      },
    );
    expect(resolved.path).toBe(commandLineTools);
    expect(resolved.source).toBe("command-line-tools");
    expect(attempted).toEqual(["selected", "/Library/Developer/CommandLineTools"]);
  });

  it("falls back when selected Git resolution fails", () => {
    const attempted: string[] = [];
    const resolved = chooseAttestedDarwinGit(
      (developerDirectory) => {
        attempted.push(developerDirectory ?? "selected");
        if (developerDirectory === undefined) throw new Error("selected-git-resolution-failed");
        return "/trusted/command-line-tools/git";
      },
      (path) => ({ path, sha256: "a".repeat(64) }),
    );
    expect(resolved).toMatchObject({
      path: "/trusted/command-line-tools/git",
      source: "command-line-tools",
    });
    expect(attempted).toEqual(["selected", "/Library/Developer/CommandLineTools"]);
  });

  it("rejects an empty selected path before attestation and uses Command Line Tools Git", () => {
    const attempted: string[] = [];
    const resolved = chooseAttestedDarwinGit(
      (developerDirectory) => {
        attempted.push(developerDirectory ?? "selected");
        return developerDirectory === undefined ? "" : "/trusted/command-line-tools/git";
      },
      (path) => ({ path, sha256: "a".repeat(64) }),
    );
    expect(resolved).toMatchObject({
      path: "/trusted/command-line-tools/git",
      source: "command-line-tools",
    });
    expect(attempted).toEqual(["selected", "/Library/Developer/CommandLineTools"]);
  });

  it("fails closed when Command Line Tools Git resolves to an empty path", () => {
    expect(() =>
      chooseAttestedDarwinGit(
        (developerDirectory) => {
          if (developerDirectory === undefined) throw new Error("selected-git-resolution-failed");
          return "";
        },
        (path) => ({ path, sha256: "a".repeat(64) }),
      ),
    ).toThrow("runtime-gateway-git-untrusted");
  });

  it("fails closed when neither selected nor Command Line Tools Git is trusted", () => {
    const attempted: string[] = [];
    expect(() =>
      chooseAttestedDarwinGit(
        (developerDirectory) => {
          attempted.push(developerDirectory ?? "selected");
          return "/untrusted/git";
        },
        () => {
          throw new Error("runtime-gateway-git-untrusted");
        },
      ),
    ).toThrow("runtime-gateway-git-untrusted");
    expect(attempted).toEqual(["selected", "/Library/Developer/CommandLineTools"]);
  });

  it("rejects an executable under a user-writable developer-tool path", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-user-xcode-"));
    const executable = join(root, "git");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    chmodSync(root, 0o777);
    try {
      expect(() => attestDarwinGitExecutable(executable)).toThrow("runtime-gateway-git-untrusted");
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
