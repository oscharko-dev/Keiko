// #3565 Observation 18: the customer's first coding run was refused because their repository's
// `origin` is their own Git server, not github.com. These pin the three identities a checkout can
// carry and that a foreign origin is an identity, never a refusal.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    expect(plain).toBe("d80403309ea86679fd369f450ac7b0f31d7f3d7715e62a1bb144643662273880");
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
      "e01032ac6e79503e9f5f650c373ca66e77bbd7d5d9d19f38621bf9028aae3807",
    );
  });

  it("strips credentials from a malformed host-only remote that carries no path", () => {
    expect(foreignOriginDigest("https://token@git.example.invalid:not-a-port")).toBe(
      "4b29b297a8ab060c95d7b0cbab6d29ec25e7e33cb9fddbb44955937dcffb563b",
    );
  });

  it.each([
    ["an empty remote", "", "ecd8f55d796792f72e1908a9100abf8be57e64fac04e26f30e44b111f21527ac"],
    [
      "a whitespace-only remote",
      "   ",
      "ecd8f55d796792f72e1908a9100abf8be57e64fac04e26f30e44b111f21527ac",
    ],
    [
      "a host-only URL",
      "https://git.example.invalid",
      "c2bd43b3c56b08f802967e2907cea3eabde5b5dfdccd34020fd7be1cc126e268",
    ],
    [
      "a bare word",
      "not-a-remote",
      "f1d7522a09d34584d59fef934dd1c7fdaf683488c9e0b0396e3186371f4ae0da",
    ],
  ])("digests %s deterministically", (_label, url, expected) => {
    // Fixed digests, not the production formula re-applied: a change to the framing must fail here.
    expect(foreignOriginDigest(url)).toBe(expected);
  });

  it("digests an scp-like remote as written, and different repositories differ", () => {
    expect(foreignOriginDigest("git@git.example.invalid:team/repo.git")).toBe(
      "fb808b1baef38a612ea387c27477e542c612b20f8ae05e68ce08719a434a1625",
    );
    expect(foreignOriginDigest("git@git.example.invalid:team/repo.git")).not.toBe(
      foreignOriginDigest("git@git.example.invalid:team/other.git"),
    );
  });

  it.each([
    ["?", "git@git.example.invalid:team/repo?one", "git@git.example.invalid:team/repo?two"],
    ["#", "git@git.example.invalid:team/repo#one", "git@git.example.invalid:team/repo#two"],
  ])("keeps %s as a path character of an scp-like remote, so distinct paths differ", (_c, a, b) => {
    // Without URL syntax there is no query or fragment to strip; cutting there would collapse
    // two different repositories onto one digest.
    expect(foreignOriginDigest(a)).not.toBe(foreignOriginDigest(b));
    expect(foreignOriginDigest(a)).not.toBe(
      foreignOriginDigest("git@git.example.invalid:team/repo"),
    );
  });

  it("digests an scp-like path that contains a `?` as written", () => {
    expect(foreignOriginDigest("git@git.example.invalid:team/repo?one")).toBe(
      "24d03624e4047acfe57fa87b17b649a695a25556c328b49be87e9a483a2797ce",
    );
  });
});
