import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  nextBetaTag,
  parseArgs,
  previousBetaTag,
  releaseBody,
} from "../release-portable-prerelease.mjs";

describe("parseArgs", () => {
  it("defaults to a plan-free dev dispatch", () => {
    expect(parseArgs([])).toEqual({
      ref: "dev",
      tag: undefined,
      runId: undefined,
      planOnly: false,
    });
  });

  it("accepts the four documented flags", () => {
    expect(
      parseArgs(["--plan-only", "--ref", "dev", "--tag", "v0.3.0-beta.9", "--run-id", "42"]),
    ).toEqual({ ref: "dev", tag: "v0.3.0-beta.9", runId: "42", planOnly: true });
  });

  it.each([[["--unknown"]], [["--tag"]], [["--ref"]]])(
    "refuses unknown or valueless flags (%j)",
    (argv) => {
      expect(parseArgs(argv)).toBeUndefined();
    },
  );
});

describe("beta tag arithmetic", () => {
  it("starts at beta.0 and increments past the highest existing beta", () => {
    expect(nextBetaTag("0.3.0", [])).toBe("v0.3.0-beta.0");
    expect(nextBetaTag("0.3.0", ["v0.3.0-beta.0", "v0.3.0-beta.1", "v0.2.15"])).toBe(
      "v0.3.0-beta.2",
    );
  });

  it("finds the direct predecessor only when it exists", () => {
    expect(previousBetaTag("v0.3.0-beta.2", ["v0.3.0-beta.1"])).toBe("v0.3.0-beta.1");
    expect(previousBetaTag("v0.3.0-beta.0", ["v0.2.15"])).toBeUndefined();
    expect(previousBetaTag("v0.3.0-beta.2", [])).toBeUndefined();
    expect(previousBetaTag("v0.3.0", ["v0.3.0-beta.1"])).toBeUndefined();
  });
});

describe("releaseBody", () => {
  const input = {
    version: "0.3.0",
    tag: "v0.3.0-beta.2",
    repository: "oscharko-dev/Keiko",
    checksums: ["abc123  keiko-macos-arm64.zip"],
    sealVerification: "verified",
    commitSha: "b2e3900a",
    runId: "31246976935",
    previousTag: "v0.3.0-beta.1",
  };

  it("carries checksums, provenance, the supersede pointer, and the GUI-only approval steps", () => {
    const body = releaseBody(input);

    expect(body).toContain("abc123  keiko-macos-arm64.zip");
    expect(body).toContain("Built from commit b2e3900a by workflow run 31246976935.");
    expect(body).toContain("Supersedes v0.3.0-beta.1.");
    expect(body).toContain("Open Anyway");
    expect(body).toContain("macOS seal verification: verified.");
    // The beta.0 lesson: the primary install path must never require a terminal.
    expect(body).not.toContain("xattr");
  });

  it("omits the supersede pointer for a first beta", () => {
    expect(releaseBody({ ...input, previousTag: undefined })).not.toContain("Supersedes");
  });
});

describe("encoded publishing lessons (source pins)", () => {
  const source = readFileSync("scripts/release-portable-prerelease.mjs", "utf8");

  it("publishes exactly the four-asset set and refuses drift", () => {
    expect(source).toContain('"keiko-macos-arm64.zip"');
    expect(source).toContain('"keiko-macos-x64.zip"');
    expect(source).toContain('"keiko-windows-x64.zip"');
    expect(source).toContain('"keiko-windows-x64-setup.exe"');
    expect(source).toContain("publish set must be exactly");
  });

  it("dispatches only the evaluation build and requires all three staging jobs", () => {
    expect(source).toContain("evaluation_build=true");
    expect(source).toContain("expected 3 staging jobs");
    expect(source).toContain('job.conclusion !== "success"');
  });

  it("pins the beta.0 damaged-bundle regression by its exact codesign text", () => {
    expect(source).toContain("code has no resources but signature indicates they must be present");
    expect(source).toContain('"--verify", "--deep", "--strict"');
    // A skipped verification is stated, never silent.
    expect(source).toContain("verification did not run");
  });

  it("creates the release as a prerelease and marks the predecessor superseded", () => {
    expect(source).toContain('"--prerelease"');
    expect(source).toContain("markPreviousSuperseded");
  });
});
