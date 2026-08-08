import * as fsModule from "node:fs";
import * as pathModule from "node:path";
import { readFileSync } from "node:fs";
import { spawnSync as realSpawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  nextBetaTag,
  parseArgs,
  previousBetaTag,
  releaseBody,
  run,
  runPortablePrerelease,
  withAssetCopier,
  withHostPlatform,
  withProcessRunner,
  withSleeper,
} from "../release-portable-prerelease.mjs";

// Resolved ONCE from this test file's own location — never from the process cwd (review finding
// on #3037).
const PRODUCTION_SCRIPT = pathModule.resolve(
  import.meta.dirname,
  "..",
  "release-portable-prerelease.mjs",
);

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

describe("encoded publishing lessons (source pins without a behavioral twin)", () => {
  // Every other former source-text pin here is proven behaviorally by the hermetic suite below
  // (publish-set guard, three-staging-job rule, damaged-signature refusal, prerelease creation
  // and supersede pointer) — only pins with no behavioral twin remain (review finding on #3037).
  const source = readFileSync(PRODUCTION_SCRIPT, "utf8");

  it("dispatches only the evaluation build", () => {
    // The hermetic dispatch double accepts any `gh workflow run` line, so only this pin holds
    // the dispatch to the evaluation lane.
    expect(source).toContain("evaluation_build=true");
  });

  it("states a skipped seal verification in the operator log, never silently", () => {
    // The release-body line has a behavioral twin (the non-darwin plan-only test); the WARNING
    // in the terminal log does not — it is what an operator watching the run sees.
    expect(source).toContain("verification did not run");
  });
});

describe("hermetic end-to-end (scripted gh double)", () => {
  const { mkdirSync, writeFileSync } = fsModule;
  const { join } = pathModule;
  // The fixture tags derive from the checkout's real version: the script binds the release to
  // the version at the BUILT commit and to the local checkout, so hardcoded tags would turn the
  // whole suite red on the next version bump (review finding on #3037).
  const localVersion = JSON.parse(
    readFileSync(pathModule.resolve(import.meta.dirname, "..", "..", "package.json"), "utf8"),
  ).version;
  const previousTag = `v${localVersion}-beta.1`;
  const currentTag = `v${localVersion}-beta.2`;

  function ghDouble(recorded, overrides = {}) {
    return (command, args) => {
      const line = [command.split("/").pop(), ...args].join(" ");
      recorded.push(line);
      if (line.startsWith("gh release create")) {
        // The notes file dies with the temp directory — snapshot the rendered release body while
        // it still exists, so tests can assert what the published surface actually said.
        const notesPath = args[args.indexOf("--notes-file") + 1];
        recorded.push(`release-body: ${readFileSync(notesPath, "utf8")}`);
      }
      if (command === "/usr/bin/unzip") {
        const dir = args[args.indexOf("-d") + 1];
        mkdirSync(join(dir, "Keiko", "Keiko.app", "Contents"), { recursive: true });
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "/usr/bin/codesign") {
        const app = String(args.at(-1));
        return (
          overrides.codesignFor?.(app) ??
          overrides.codesign ?? { status: 0, stdout: "", stderr: "" }
        );
      }
      return ghAnswer(args, overrides);
    };
  }

  function ghAnswer(args, overrides) {
    const joined = args.join(" ");
    for (const [needle, answer] of overrides.answers ?? []) {
      if (joined.includes(needle)) return { status: 0, stdout: answer, stderr: "" };
    }
    if (joined.startsWith("run download")) {
      const dir = args[args.indexOf("--dir") + 1];
      const artifact = args[args.indexOf("--name") + 1];
      const target = overrides.nestArtifacts === true ? join(dir, "nested") : dir;
      mkdirSync(target, { recursive: true });
      for (const file of artifactFiles(artifact, overrides)) {
        writeFileSync(join(target, file), `fixture bytes for ${file}`);
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
      ["api repos/{owner}/{repo}/releases", JSON.stringify([{ tag_name: previousTag }])],
      // The manifest at the BUILT commit, served through the GitHub contents API: by default it
      // agrees with the local checkout; the red paths override it (review finding on #3037).
      ["contents/package.json", JSON.stringify({ version: localVersion })],
      ["run list --workflow", '[{"databaseId":42,"status":"in_progress"}]'],
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
        runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
      ),
    );

    const createLine = recorded.find((line) => line.startsWith("gh release create"));
    expect(createLine).toContain(currentTag);
    expect(createLine).toContain("--prerelease");
    // The tag binds to the exact commit the workflow built, never a moving branch ref — assets
    // and release source must agree even when the branch advanced mid-run (review finding on
    // #3032).
    expect(createLine).toContain("--target b2e3900a");
    expect(createLine).not.toContain("--target dev");
    // The built commit's manifest was read at the exact head sha the run reports — the version
    // binding judges the BUILT commit, not the local checkout alone (review finding on #3037).
    expect(recorded.some((line) => line.includes("contents/package.json?ref=b2e3900a"))).toBe(true);
    // Exactly the four-asset publish set, by name — the behavioral twin of the former source pin.
    expect(createLine).toContain("keiko-macos-arm64.zip");
    expect(createLine).toContain("keiko-macos-x64.zip");
    expect(createLine).toContain("keiko-windows-x64.zip");
    expect(createLine).toContain("keiko-windows-x64-setup.exe");
    // The predecessor got the superseded pointer prepended.
    expect(recorded.some((line) => line.startsWith(`gh release edit ${previousTag}`))).toBe(true);
    // BOTH macOS seals were verified on the darwin host before anything published, and the
    // release body names what was verified (review finding on #3037).
    expect(
      recorded.filter((line) => line.includes("codesign --verify --deep --strict")),
    ).toHaveLength(2);
    const bodyLine = recorded.find((line) => line.startsWith("release-body: "));
    expect(bodyLine).toContain(
      "macOS seal verification: verified (keiko-macos-arm64.zip, keiko-macos-x64.zip).",
    );
  });

  it("refuses to publish when a staging job failed", () => {
    const recorded = [];
    const jobs = goodJobs().map((job, index) =>
      index === 1 ? { ...job, conclusion: "failure" } : job,
    );

    expect(() =>
      withHostPlatform("darwin", () =>
        withProcessRunner(ghDouble(recorded, { jobs }), () =>
          runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
        ),
      ),
    ).toThrowError(/staging jobs failed/u);
    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
  });

  it("removes the temporary work directory on refusals and plan-only runs", () => {
    // Review findings on #3032: fail() exits must not orphan the mkdtemp directory, and a
    // plan-only run must clean up after itself as well.
    const workDirOf = (recorded) => {
      const download = recorded.find((line) => line.includes("run download"));
      const parts = download.split(" ");
      return pathModule.dirname(parts[parts.indexOf("--dir") + 1]);
    };

    const refusalRecorded = [];
    const codesign = { status: 1, stderr: "generic verification failure" };
    expect(() =>
      withHostPlatform("darwin", () =>
        withProcessRunner(ghDouble(refusalRecorded, { codesign }), () =>
          runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
        ),
      ),
    ).toThrowError(/codesign/u);
    expect(fsModule.existsSync(workDirOf(refusalRecorded))).toBe(false);

    const planRecorded = [];
    withHostPlatform("darwin", () =>
      withProcessRunner(ghDouble(planRecorded), () =>
        runPortablePrerelease(["--plan-only", "--run-id", "42", "--tag", currentTag]),
      ),
    );
    expect(fsModule.existsSync(workDirOf(planRecorded))).toBe(false);
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
          runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
        ),
      ),
    ).toThrowError(/artifact is missing the expected asset/u);
    // The refusal happened INSIDE assembly — the temp directory must not survive it either
    // (review finding on #3037).
    const download = recorded.find((line) => line.includes("run download"));
    const parts = download.split(" ");
    expect(fsModule.existsSync(pathModule.dirname(parts[parts.indexOf("--dir") + 1]))).toBe(false);
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
          runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
        ),
      ),
    ).toThrowError(/damaged/u);
    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
  });

  it("refuses a damaged x64 seal even when the arm64 bundle is healthy", () => {
    // Review finding on #3037: only the arm64 archive was ever codesign-verified, so
    // keiko-macos-x64.zip could publish with zero evidence about its own bytes. Both macOS
    // archives must be extracted and judged; a failure in either refuses the publish.
    const recorded = [];
    const codesignFor = (app) =>
      app.includes("keiko-macos-x64.zip")
        ? {
            status: 1,
            stdout: "",
            stderr: "code has no resources but signature indicates they must be present",
          }
        : { status: 0, stdout: "", stderr: "" };

    expect(() =>
      withHostPlatform("darwin", () =>
        withProcessRunner(ghDouble(recorded, { codesignFor }), () =>
          runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
        ),
      ),
    ).toThrowError(/damaged/u);
    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
    // Both bundles were extracted and judged — the x64 seal is evidence, not a bystander.
    expect(
      recorded.filter((line) => line.includes("codesign --verify --deep --strict")),
    ).toHaveLength(2);
  });

  it("states the skipped seal verification out loud on a non-darwin host", () => {
    const recorded = [];
    const stdout = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    try {
      withHostPlatform("linux", () =>
        withProcessRunner(ghDouble(recorded), () =>
          runPortablePrerelease(["--plan-only", "--run-id", "42", "--tag", currentTag]),
        ),
      );
    } finally {
      write.mockRestore();
    }

    expect(recorded.some((line) => line.includes("codesign"))).toBe(false);
    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
    // The skip reaches the published surface, not only the log: the rendered release body states
    // it (review finding on #3037).
    expect(stdout.join("")).toContain("macOS seal verification: skipped-non-darwin.");
  });

  it("dispatches and binds to the run created by this dispatch, never a pre-existing one", () => {
    const recorded = [];
    const waits = [];
    let listCalls = 0;
    // The static answer table cannot flip mid-run, so this double answers the run list by call
    // count: only the pre-existing run 41 before the dispatch, run 43 joining it afterwards. Run
    // 41 stays FIRST in the post-dispatch list — the old `--limit 1` selection would pick it and
    // publish another run's assets (review finding on #3037).
    const doubleBase = ghDouble(recorded, {});
    const flipping = (command, args, options) => {
      if (args.join(" ").startsWith("run list")) {
        listCalls += 1;
        return {
          status: 0,
          stdout: listCalls === 1 ? '[{"databaseId":41}]' : '[{"databaseId":41},{"databaseId":43}]',
          stderr: "",
        };
      }
      return doubleBase(command, args, options);
    };
    withSleeper(
      (ms) => waits.push(ms),
      () =>
        withHostPlatform("darwin", () =>
          withProcessRunner(flipping, () => runPortablePrerelease(["--tag", currentTag])),
        ),
    );

    expect(recorded.some((line) => line.startsWith("gh workflow run"))).toBe(true);
    // Only the id that was absent from the pre-dispatch set is the dispatched run.
    expect(recorded.some((line) => line.startsWith("gh run view 43 "))).toBe(true);
    expect(recorded.some((line) => line.startsWith("gh run view 41"))).toBe(false);
    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(true);
    // The dispatch waits for the run to exist — through the seam, not a real wall-clock.
    expect(waits.length).toBeGreaterThan(0);
  });

  it("refuses when the dispatched run never appears instead of guessing at an existing run", () => {
    const recorded = [];
    const waits = [];
    // The static run list never changes: the pre-dispatch run 42 stays the only entry, so no run
    // attributable to THIS dispatch ever appears — a bounded refusal, never a guess.
    expect(() =>
      withSleeper(
        (ms) => waits.push(ms),
        () =>
          withProcessRunner(ghDouble(recorded), () => runPortablePrerelease(["--tag", currentTag])),
      ),
    ).toThrowError(/did not appear/u);

    expect(recorded.some((line) => line.startsWith("gh workflow run"))).toBe(true);
    expect(recorded.some((line) => line.startsWith("gh run view"))).toBe(false);
    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
    // Every poll waited through the seam; the attempts are bounded, not a hang.
    expect(waits.length).toBeGreaterThan(1);
  });

  it("refuses a run whose built commit carries a different package version", () => {
    // With --run-id an operator can point at any older run — a v<version>-beta.N release must
    // never carry another package version's assets (review finding on #3037).
    const recorded = [];
    const overrides = { answers: [["contents/package.json", '{"version":"0.0.0-other"}']] };

    expect(() =>
      withHostPlatform("darwin", () =>
        withProcessRunner(ghDouble(recorded, overrides), () =>
          runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
        ),
      ),
    ).toThrowError(`builds version 0.0.0-other but the local checkout is ${localVersion}`);
    // The refusal names both versions and happens before any asset is even downloaded.
    expect(recorded.some((line) => line.startsWith("gh run download"))).toBe(false);
    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
  });

  it("refuses a --tag that does not name the built version", () => {
    const recorded = [];

    expect(() =>
      withHostPlatform("darwin", () =>
        withProcessRunner(ghDouble(recorded), () =>
          runPortablePrerelease(["--run-id", "42", "--tag", "v9.9.9-beta.0"]),
        ),
      ),
    ).toThrowError(
      `tag v9.9.9-beta.0 does not name the built version ${localVersion} (expected v${localVersion}-beta.<n>)`,
    );
    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
  });

  it("refuses a tag that already exists", () => {
    expect(() =>
      withProcessRunner(ghDouble([]), () =>
        runPortablePrerelease(["--run-id", "42", "--tag", previousTag]),
      ),
    ).toThrowError(/already exists/u);
  });

  it("refuses to publish from a cancelled run", () => {
    const overrides = {
      answers: [
        [
          "--json status,conclusion,headSha",
          '{"status":"completed","conclusion":"cancelled","headSha":"x"}',
        ],
      ],
    };

    expect(() =>
      withProcessRunner(ghDouble([], overrides), () =>
        runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
      ),
    ).toThrowError(/concluded cancelled/u);
  });

  it("polls a still-running workflow through the sleeper seam", () => {
    const recorded = [];
    const waits = [];
    let polls = 0;
    // The static answer table cannot flip mid-run, so this double answers the status poll by
    // call count: still running first, then completed.
    const doubleBase = ghDouble(recorded, {});
    const polling = (command, args, options) => {
      if (args.join(" ").includes("--json status,conclusion,headSha")) {
        polls += 1;
        return {
          status: 0,
          stdout:
            polls === 1
              ? '{"status":"in_progress"}'
              : '{"status":"completed","conclusion":"success","headSha":"b2e3900a"}',
          stderr: "",
        };
      }
      return doubleBase(command, args, options);
    };
    withSleeper(
      (ms) => waits.push(ms),
      () =>
        withHostPlatform("darwin", () =>
          withProcessRunner(polling, () =>
            runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
          ),
        ),
    );

    expect(polls).toBeGreaterThan(1);
    expect(waits.length).toBeGreaterThan(0);
  });

  it("publishes a first beta without touching a predecessor", () => {
    const recorded = [];
    const overrides = { answers: [["api repos/{owner}/{repo}/releases", "[]"]] };
    withHostPlatform("darwin", () =>
      withProcessRunner(ghDouble(recorded, overrides), () =>
        runPortablePrerelease(["--run-id", "42", "--tag", `v${localVersion}-beta.0`]),
      ),
    );

    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(true);
    expect(recorded.some((line) => line.startsWith("gh release edit"))).toBe(false);
  });

  it("leaves an already-superseded predecessor untouched", () => {
    const recorded = [];
    const overrides = {
      answers: [
        ["api repos/oscharko-dev/Keiko/releases/tags/", '{"body":"> **Superseded by x.**"}'],
      ],
    };
    withHostPlatform("darwin", () =>
      withProcessRunner(ghDouble(recorded, overrides), () =>
        runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
      ),
    );

    expect(recorded.some((line) => line.startsWith("gh release edit"))).toBe(false);
  });

  it("finds staged assets nested one directory deep in an artifact", () => {
    const recorded = [];
    withHostPlatform("darwin", () =>
      withProcessRunner(ghDouble(recorded, { nestArtifacts: true }), () =>
        runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
      ),
    );

    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(true);
  });

  it("refuses a stray extra file in the assembled publish set", () => {
    const recorded = [];
    // A corrupted copy step drops an extra file next to the target — the publish-set guard must
    // catch exactly this class. Injected through the copier seam, like every other seam.
    const strayCopier = (source, destination) => {
      fsModule.copyFileSync(source, destination);
      writeFileSync(join(pathModule.dirname(destination), "stray.bin"), "stray");
    };

    expect(() =>
      withAssetCopier(strayCopier, () =>
        withHostPlatform("darwin", () =>
          withProcessRunner(ghDouble(recorded), () =>
            runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
          ),
        ),
      ),
    ).toThrowError(/publish set must be exactly/u);
  });

  it("refuses when the staging job set is incomplete", () => {
    const jobs = goodJobs().slice(1);

    expect(() =>
      withHostPlatform("darwin", () =>
        withProcessRunner(ghDouble([], { jobs }), () =>
          runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
        ),
      ),
    ).toThrowError(/expected 3 staging jobs/u);
  });

  it("refuses a failing codesign verdict that is not the damaged signature", () => {
    const codesign = { status: 1, stderr: "generic verification failure" };

    expect(() =>
      withHostPlatform("darwin", () =>
        withProcessRunner(ghDouble([], { codesign }), () =>
          runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
        ),
      ),
    ).toThrowError(/codesign --verify --deep --strict failed/u);
  });

  it("refuses unusable arguments with the documented usage line", () => {
    expect(() => runPortablePrerelease(["--bogus"])).toThrowError(/usage: /u);
  });
});

describe("run (process seam)", () => {
  it("returns stdout from a real local process through the default runner", () => {
    expect(run("/bin/echo", ["hermetic"])).toContain("hermetic");
  });

  it("surfaces a spawn error and a non-zero exit as refusals", () => {
    expect(() =>
      withProcessRunner(
        () => ({ error: new Error("boom") }),
        () => run("x", []),
      ),
    ).toThrowError(/could not spawn: boom/u);
    expect(() =>
      withProcessRunner(
        () => ({ status: 3, stderr: "sad" }),
        () => run("x", ["y"]),
      ),
    ).toThrowError(/exited 3/u);
  });
});

describe("CLI shim", () => {
  it("exits 1 with the usage line when invoked directly with unusable flags", () => {
    const result = realSpawn(process.execPath, [PRODUCTION_SCRIPT, "--bogus"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage: release-portable-prerelease");
  });
});
