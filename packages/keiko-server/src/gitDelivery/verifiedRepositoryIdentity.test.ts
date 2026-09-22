// #3565 Observation 18: the customer's first coding run was refused because their repository's
// `origin` is their own Git server, not github.com. These pin the three identities a checkout can
// carry and that a foreign origin is an identity, never a refusal.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { codingWorkbenchRemoteDigest } from "../coding-context/githubIssueResolution.js";
import {
  foreignOriginDigest,
  readVerifiedRepositoryIdentity,
} from "./verifiedRepositoryIdentity.js";

let root: string;
let workspace: WorkspaceInfo;
const LOCAL_DIGEST = "c".repeat(64);

function git(args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-repository-identity-")));
  git(["init", "-qb", "main"]);
  workspace = {
    root,
    selectedRoot: root,
    name: "fixture",
    version: undefined,
    testFramework: "vitest",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readVerifiedRepositoryIdentity", () => {
  it("reports a checkout without an origin as the local identity", async () => {
    await expect(readVerifiedRepositoryIdentity({ workspace }, LOCAL_DIGEST)).resolves.toEqual({
      kind: "local",
      digest: LOCAL_DIGEST,
    });
  });

  it("reports a github.com origin as the GitHub identity", async () => {
    git(["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
    await expect(readVerifiedRepositoryIdentity({ workspace }, LOCAL_DIGEST)).resolves.toEqual({
      kind: "github-origin",
      digest: codingWorkbenchRemoteDigest("acme/widgets"),
    });
  });

  it.each([
    ["an https origin on a company Git server", "https://git.example.invalid/team/repo.git"],
    ["an ssh origin on a company Git server", "ssh://git@git.example.invalid:7999/team/repo.git"],
    ["an scp-like origin on a company Git server", "git@git.example.invalid:team/repo.git"],
  ])("reports %s as a foreign origin instead of refusing the run", async (_label, url) => {
    git(["remote", "add", "origin", url]);
    await expect(readVerifiedRepositoryIdentity({ workspace }, LOCAL_DIGEST)).resolves.toEqual({
      kind: "foreign-origin",
      digest: foreignOriginDigest(url),
    });
  });
});

describe("foreignOriginDigest", () => {
  it("digests scheme, host and path only, so an embedded token never changes or feeds the digest", () => {
    const plain = foreignOriginDigest("https://git.example.invalid/team/repo.git");
    expect(plain).toBe(sha256Hex("origin/https://git.example.invalid/team/repo.git"));
    expect(foreignOriginDigest("https://user:s3cret@git.example.invalid/team/repo.git?x=1#f")).toBe(
      plain,
    );
    expect(foreignOriginDigest("  https://git.example.invalid/team/repo.git\n")).toBe(plain);
  });

  it.each([
    ["an invalid port with a token", "https://token@git.example.invalid:not-a-port/team/repo.git"],
    [
      "an invalid port with user and password",
      "https://user:s3cret@git.example.invalid:not-a-port/team/repo.git?x=1#f",
    ],
  ])("strips credentials from a malformed remote with %s before digesting", (_label, url) => {
    // The WHATWG parser refuses these, so the raw branch runs; a token must not reach the digest.
    expect(foreignOriginDigest(url)).toBe(
      sha256Hex("origin/https://git.example.invalid:not-a-port/team/repo.git"),
    );
  });

  it("strips credentials from a malformed host-only remote that carries no path", () => {
    expect(foreignOriginDigest("https://token@git.example.invalid:not-a-port")).toBe(
      sha256Hex("origin/https://git.example.invalid:not-a-port"),
    );
  });

  it.each([
    ["an empty remote", "", "origin/"],
    ["a whitespace-only remote", "   ", "origin/"],
    ["a host-only URL", "https://git.example.invalid", "origin/https://git.example.invalid/"],
    ["a bare word", "not-a-remote", "origin/not-a-remote"],
  ])("digests %s deterministically", (_label, url, expected) => {
    expect(foreignOriginDigest(url)).toBe(sha256Hex(expected));
  });

  it("digests an scp-like remote as written, and different repositories differ", () => {
    expect(foreignOriginDigest("git@git.example.invalid:team/repo.git")).toBe(
      sha256Hex("origin/git@git.example.invalid:team/repo.git"),
    );
    expect(foreignOriginDigest("git@git.example.invalid:team/repo.git")).not.toBe(
      foreignOriginDigest("git@git.example.invalid:team/other.git"),
    );
  });
});
