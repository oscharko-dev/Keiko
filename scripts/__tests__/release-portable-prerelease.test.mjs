import * as fsModule from "node:fs";
import * as pathModule from "node:path";
import { readFileSync } from "node:fs";
import { spawnSync as realSpawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  nextBetaTag,
  parseArgs,
  previousBetaTag,
  releaseBody,
  runPortablePrerelease,
  withHostPlatform,
  withProcessRunner,
} from "../release-portable-prerelease.mjs";

function realSpawn(command, args, options) {
  return realSpawnSync(command, args, { encoding: "utf8", ...options });
}

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

describe("hermetic end-to-end (scripted gh double)", () => {
  const { mkdirSync, writeFileSync } = fsModule;
  const { join } = pathModule;

  function ghDouble(recorded, overrides = {}) {
    return (command, args, options = {}) => {
      const line = [command.split("/").pop(), ...args].join(" ");
      recorded.push(line);
      if (command.endsWith("mkdir") || command.endsWith("cp") || command.endsWith("sh")) {
        return realSpawn(command, args, options);
      }
      if (command === "/usr/bin/unzip") {
        const dir = args[args.indexOf("-d") + 1];
        mkdirSync(join(dir, "Keiko", "Keiko.app", "Contents"), { recursive: true });
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "/usr/bin/codesign") {
        return overrides.codesign ?? { status: 0, stdout: "", stderr: "" };
      }
      return ghAnswer(args, overrides);
    };
  }

  function ghAnswer(args, overrides) {
    const joined = args.join(" ");
    if (joined.startsWith("run download")) {
      const dir = args[args.indexOf("--dir") + 1];
      const artifact = args[args.indexOf("--name") + 1];
      mkdirSync(dir, { recursive: true });
      for (const file of artifactFiles(artifact, overrides)) {
        writeFileSync(join(dir, file), `fixture bytes for ${file}`);
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    if (joined.includes("--json jobs")) {
      return {
        status: 0,
        stdout: JSON.stringify({ jobs: overrides.jobs ?? goodJobs() }),
        stderr: "",
      };
    }
    return { status: 0, stdout: staticGhAnswer(joined), stderr: "" };
  }

  function staticGhAnswer(joined) {
    const answers = [
      ["repo view", '{"nameWithOwner":"oscharko-dev/Keiko"}'],
      ["api repos/{owner}/{repo}/releases", '[{"tag_name":"v0.3.0-beta.1"}]'],
      [
        "--json status,conclusion,headSha",
        '{"status":"completed","conclusion":"success","headSha":"b2e3900a"}',
      ],
      ["api repos/oscharko-dev/Keiko/releases/tags/", '{"body":"old beta.1 body"}'],
    ];
    for (const [needle, answer] of answers) {
      if (joined.includes(needle)) return answer;
    }
    return "";
  }

  function goodJobs() {
    return [
      { name: "Stage portable asset (windows-x64)", conclusion: "success" },
      { name: "Stage portable asset (macos-arm64)", conclusion: "success" },
      { name: "Stage portable asset (macos-x64)", conclusion: "success" },
      { name: "Authorize production signing", conclusion: "skipped" },
    ];
  }

  function artifactFiles(artifact, overrides) {
    if (overrides.artifactFiles?.[artifact] !== undefined) return overrides.artifactFiles[artifact];
    if (artifact.includes("windows"))
      return ["keiko-windows-x64.zip", "keiko-windows-x64-setup.exe"];
    if (artifact.includes("arm64")) return ["keiko-macos-arm64.zip"];
    return ["keiko-macos-x64.zip"];
  }

  it("publishes the four verified assets with checksums, provenance, and the supersede pointer", () => {
    const recorded = [];
    withHostPlatform("darwin", () =>
      withProcessRunner(ghDouble(recorded), () =>
        runPortablePrerelease(["--run-id", "42", "--tag", "v0.3.0-beta.2"]),
      ),
    );

    const createLine = recorded.find((line) => line.startsWith("gh release create"));
    expect(createLine).toContain("v0.3.0-beta.2");
    expect(createLine).toContain("--prerelease");
    expect(createLine).toContain("keiko-macos-arm64.zip");
    expect(createLine).toContain("keiko-windows-x64-setup.exe");
    // The predecessor got the superseded pointer prepended.
    expect(recorded.some((line) => line.startsWith("gh release edit v0.3.0-beta.1"))).toBe(true);
    // The seal was verified on the darwin host before anything published.
    expect(recorded.some((line) => line.includes("codesign --verify --deep --strict"))).toBe(true);
  });

  it("refuses to publish when a staging job failed", () => {
    const recorded = [];
    const jobs = goodJobs().map((job, index) =>
      index === 1 ? { ...job, conclusion: "failure" } : job,
    );

    expect(() =>
      withHostPlatform("darwin", () =>
        withProcessRunner(ghDouble(recorded, { jobs }), () =>
          runPortablePrerelease(["--run-id", "42", "--tag", "v0.3.0-beta.2"]),
        ),
      ),
    ).toThrowError(/staging jobs failed/u);
    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
  });

  it("refuses a drifting publish set instead of shipping stray binaries", () => {
    const recorded = [];
    const overrides = {
      artifactFiles: {
        "portable-stage-windows-x64-evaluation-unsigned": [
          "keiko-windows-x64.zip",
          "keiko-windows-x64-setup.exe",
          "keiko-macos-arm64.zip",
        ],
        "portable-stage-macos-arm64-evaluation-unsigned": [],
      },
    };

    expect(() =>
      withHostPlatform("darwin", () =>
        withProcessRunner(ghDouble(recorded, overrides), () =>
          runPortablePrerelease(["--run-id", "42", "--tag", "v0.3.0-beta.2"]),
        ),
      ),
    ).toThrowError(/artifact is missing the expected asset/u);
  });

  it("refuses the beta.0 damaged-bundle signature text before publishing", () => {
    const recorded = [];
    const codesign = {
      status: 1,
      stdout: "",
      stderr: "code has no resources but signature indicates they must be present",
    };

    expect(() =>
      withHostPlatform("darwin", () =>
        withProcessRunner(ghDouble(recorded, { codesign }), () =>
          runPortablePrerelease(["--run-id", "42", "--tag", "v0.3.0-beta.2"]),
        ),
      ),
    ).toThrowError(/damaged/u);
    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
  });

  it("states the skipped seal verification out loud on a non-darwin host", () => {
    const recorded = [];
    withHostPlatform("linux", () =>
      withProcessRunner(ghDouble(recorded), () =>
        runPortablePrerelease(["--plan-only", "--run-id", "42", "--tag", "v0.3.0-beta.2"]),
      ),
    );

    expect(recorded.some((line) => line.includes("codesign"))).toBe(false);
    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
  });
});
