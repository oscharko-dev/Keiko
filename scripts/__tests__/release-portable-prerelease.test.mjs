import * as fsModule from "node:fs";
import * as pathModule from "node:path";
import { readFileSync } from "node:fs";
import { spawnSync as realSpawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  assertTagKeepsBetaSequenceMonotonic,
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
      publicRelease: false,
    });
  });

  it("accepts the documented flags", () => {
    expect(
      parseArgs(["--plan-only", "--ref", "dev", "--tag", "v0.3.0-beta.9", "--run-id", "42"]),
    ).toEqual({
      ref: "dev",
      tag: "v0.3.0-beta.9",
      runId: "42",
      planOnly: true,
      publicRelease: false,
    });
    expect(parseArgs(["--public-release", "--run-id", "42"])).toEqual({
      ref: "dev",
      tag: undefined,
      runId: "42",
      planOnly: false,
      publicRelease: true,
    });
  });

  it("refuses a --tag override in public-release mode", () => {
    // The public release IS the exact stable tag of the built version, so an override could only
    // ever name a different release than the one being published. Refused, never ignored.
    expect(parseArgs(["--public-release", "--tag", "v0.3.1-beta.0"])).toBeUndefined();
  });

  it.each([[["--unknown"]], [["--tag"]], [["--ref"]]])(
    "refuses unknown or valueless flags (%j)",
    (argv) => {
      expect(parseArgs(argv)).toBeUndefined();
    },
  );
});

function ghDoubleStub() {
  return () => ({ status: 0, stdout: "{}", stderr: "" });
}

describe("beta tag arithmetic", () => {
  it("starts at beta.0 and increments past the highest existing beta", () => {
    expect(nextBetaTag("0.3.0", [])).toBe("v0.3.0-beta.0");
    expect(nextBetaTag("0.3.0", ["v0.3.0-beta.0", "v0.3.0-beta.1", "v0.2.15"])).toBe(
      "v0.3.0-beta.2",
    );
  });

  it("refuses a --tag override whose beta index the release verification would reject", () => {
    // Review finding on #3043: the script accepted \d+ (v0.3.0-beta.00 included) while the
    // Release verification regex requires (0|[1-9][0-9]*) — the lane could publish a tag whose
    // own verification run then stays red. One format, owned here.
    expect(() =>
      withProcessRunner(ghDoubleStub(), () =>
        runPortablePrerelease(["--tag", "v0.3.0-beta.00", "--plan-only"]),
      ),
    ).toThrowError(/beta index|does not match the governed beta tag shape/u);
  });

  it("allows resuming the highest existing beta while refusing anything below it", () => {
    // Boundary of the monotonicity guard: equal is not below (draft resumption), strictly
    // higher existing betas refuse (review finding on #3037).
    expect(() =>
      assertTagKeepsBetaSequenceMonotonic("v0.3.0-beta.9", ["v0.3.0-beta.9"]),
    ).not.toThrow();
    expect(() => assertTagKeepsBetaSequenceMonotonic("v0.3.0-beta.8", ["v0.3.0-beta.9"])).toThrow(
      /below the existing v0\.3\.0-beta\.9/u,
    );
  });

  it("finds the greatest existing lower beta as the predecessor", () => {
    expect(previousBetaTag("v0.3.0-beta.2", ["v0.3.0-beta.1"])).toBe("v0.3.0-beta.1");
    // A --tag override may skip numbers — the still-live latest beta must still be superseded
    // (review finding on #3037).
    expect(previousBetaTag("v0.3.0-beta.9", ["v0.3.0-beta.1"])).toBe("v0.3.0-beta.1");
    expect(previousBetaTag("v0.3.0-beta.9", ["v0.3.0-beta.1", "v0.3.0-beta.4", "v0.2.15"])).toBe(
      "v0.3.0-beta.4",
    );
    expect(previousBetaTag("v0.3.0-beta.0", ["v0.2.15"])).toBeUndefined();
    expect(previousBetaTag("v0.3.0-beta.2", [])).toBeUndefined();
    // The stable public tag supersedes its greatest evaluation beta; without it the last beta
    // stays live with no pointer to the stable Latest release (Codex finding on #3054).
    expect(previousBetaTag("v0.3.0", ["v0.3.0-beta.1"])).toBe("v0.3.0-beta.1");
    expect(previousBetaTag("v0.3.0", ["v0.3.0-beta.1", "v0.3.0-beta.4", "v0.2.15"])).toBe(
      "v0.3.0-beta.4",
    );
    expect(previousBetaTag("v0.3.0", ["v0.2.15"])).toBeUndefined();
    // A higher existing beta is never "previous" for a lower tag.
    expect(previousBetaTag("v0.3.0-beta.2", ["v0.3.0-beta.4"])).toBeUndefined();
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

  it("states the unsigned status to a customer in public-release mode and keeps the install steps", () => {
    // The public release must never quietly drop the honest signing statement: it is the reason
    // the first launch needs an extra confirmation, and ADR-0121 D1 bounds the evaluation status
    // on the condition that the notes state it. The prerelease-only sentence must not survive —
    // this release IS publishable to npm latest.
    const body = releaseBody({
      ...input,
      tag: "v0.3.1",
      version: "0.3.1",
      previousTag: undefined,
      publicRelease: true,
    });

    expect(body).toContain("# Keiko 0.3.1");
    expect(body).toContain("Unsigned evaluation build");
    expect(body).not.toContain("Not publishable to npm latest");
    expect(body).not.toContain("evaluation prerelease");
    // The install steps a non-technical customer follows are the same ones the betas proved.
    expect(body).toContain("Open Anyway");
    expect(body).toContain("keiko-windows-x64-setup.exe");
    expect(body).not.toContain("xattr");
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

  /**
   * The governance answers a public release needs: the checkout binding, the release-source branch
   * lookup, and the two verifier subprocesses. Separated from the artifact/codesign double below
   * so each stays readable.
   */
  function governanceAnswer(line, overrides) {
    // The publisher checkout binding: by default this checkout IS the built commit and clean.
    if (line.startsWith("git rev-parse HEAD")) {
      return { status: 0, stdout: `${overrides.head ?? "b2e3900a"}\n`, stderr: "" };
    }
    if (line.startsWith("git status --porcelain")) {
      return { status: 0, stdout: overrides.dirty ?? "", stderr: "" };
    }
    // The release base branch declared by release.yml does not exist in this repository, so the
    // source branch resolves to the default branch — exactly what it does live. An ABSENT branch
    // is a 404; the resolver refuses any other failure rather than guessing, so the double states
    // which of the two it is answering.
    if (line.includes("/branches/")) {
      if (overrides.releaseBranchExists === true) return { status: 0, stdout: "{}", stderr: "" };
      // The double answers with gh's REAL absence message: an invented "gh: Not Found" here let
      // the production needle miss the live "(HTTP 404)" and refuse a genuine absence (0.3.1).
      return {
        status: 1,
        stdout: "",
        stderr: overrides.branchLookupError ?? "gh: Branch not found (HTTP 404)",
      };
    }
    // The release-owner allowlist comes from the repository variable the release workflow injects.
    if (line.includes("/actions/variables/KEIKO_RELEASE_OWNER_GITHUB_LOGINS")) {
      if (overrides.allowlistUnavailable === true) {
        return { status: 1, stdout: "", stderr: "gh: HTTP 403" };
      }
      return { status: 0, stdout: '{"value":"release-owner"}', stderr: "" };
    }
    return verifierAnswer(line, overrides);
  }

  /**
   * The required-checks verifier and the live release-owner approval gate are spawned through the
   * same process seam as gh, so they are answered here: success unless a test scripts a failure.
   */
  function verifierAnswer(line, overrides) {
    if (
      !line.includes("verify-release-required-checks") &&
      !line.includes("check-release-impact")
    ) {
      return undefined;
    }
    const scripted = (overrides.failures ?? []).find(([needle]) => line.includes(needle));
    return scripted === undefined
      ? { status: 0, stdout: "", stderr: "" }
      : { status: 1, stdout: "", stderr: scripted[1] };
  }

  function ghDouble(recorded, overrides = {}) {
    return (command, args) => {
      const line = [command.split("/").pop(), ...args].join(" ");
      recorded.push(line);
      const governance = governanceAnswer(line, overrides);
      if (governance !== undefined) return governance;
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

  // Scripted per-test outcomes: `failures` matches win (status 1 with the given stderr), then
  // `answers` (status 0 with the given stdout) — the double stays a pure lookup.
  function scriptedGhAnswer(joined, overrides) {
    for (const [needle, failure] of overrides.failures ?? []) {
      if (joined.includes(needle)) return { status: 1, stdout: "", stderr: failure };
    }
    for (const [needle, answer] of overrides.answers ?? []) {
      if (joined.includes(needle)) return { status: 0, stdout: answer, stderr: "" };
    }
    return undefined;
  }

  // Default git-ref answers: the atomic tag POST succeeds (the ref did not exist), and a tag-ref
  // lookup finds the tag at the built commit — the publication-boundary recheck runs on EVERY
  // publish, so the default mirrors what ensureTagRefAtBuiltCommit just guaranteed. Moved-tag
  // and vanished-tag scenarios override via `failures`/`answers` (#3037).
  function defaultGhRefAnswer(joined) {
    // The repository view, used to resolve the release source branch when release.yml's declared
    // base branch does not exist.
    if (joined === "api repos/oscharko-dev/Keiko") {
      return { status: 0, stdout: '{"default_branch":"dev"}', stderr: "" };
    }
    if (joined.startsWith("api --method POST repos/{owner}/{repo}/git/refs")) {
      return { status: 0, stdout: "{}", stderr: "" };
    }
    if (joined.startsWith("api repos/{owner}/{repo}/git/ref/tags/")) {
      return {
        status: 0,
        stdout: '{"ref":"refs/tags/x","object":{"type":"commit","sha":"b2e3900a"}}',
        stderr: "",
      };
    }
    return undefined;
  }

  function ghAnswer(args, overrides) {
    const joined = args.join(" ");
    const scripted = scriptedGhAnswer(joined, overrides) ?? defaultGhRefAnswer(joined);
    if (scripted !== undefined) return scripted;
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
      ["repos/{owner}/{repo}/releases?per_page", JSON.stringify([{ tag_name: previousTag }])],
      // The manifest at the BUILT commit, served through the GitHub contents API: by default it
      // agrees with the local checkout; the red paths override it (review finding on #3037).
      ["contents/package.json", JSON.stringify({ version: localVersion })],
      ["run list --workflow", '[{"databaseId":42,"status":"in_progress"}]'],
      [
        "--json status,conclusion,headSha",
        '{"status":"completed","conclusion":"success","headSha":"b2e3900a","event":"workflow_dispatch","headBranch":"dev","workflowDatabaseId":7,"attempt":1}',
      ],
      // The attempt-coherence re-read after artifacts and bytes are gathered.
      ["--json attempt", '{"attempt":1}'],
      // The run's artifact listing: the public-release manifest records these immutable ids so
      // the npm publisher can refuse a rerun's replacement artifacts.
      [
        "/artifacts?per_page",
        JSON.stringify({
          artifacts: [
            { name: "portable-stage-macos-arm64-evaluation-unsigned", id: 700001, expired: false },
            { name: "portable-stage-macos-x64-evaluation-unsigned", id: 700002, expired: false },
            { name: "portable-stage-windows-x64-evaluation-unsigned", id: 700003, expired: false },
          ],
        }),
      ],
      // The portable-assets workflow's database id, resolved from its path — supplied-run
      // binding compares the run's workflowDatabaseId against it (#3037).
      ["actions/workflows/portable-assets.yml", '{"id":7}'],
      ["api repos/oscharko-dev/Keiko/releases/tags/", '{"body":"old beta.1 body"}'],
      // An existing tag is a PUBLISHED release unless a test overrides it to a draft — the
      // published case must keep the historical refusal (review finding on #3037).
      ["release view", '{"isDraft":false}'],
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

  describe("public release source gate", () => {
    // A beta may be cut from any ref; that is what a prerelease is for. A PUBLIC release becomes
    // the Latest download a customer installs, so its bytes must come from integrated,
    // gate-verified source. The workflow's own tag-push verification cannot answer this: it only
    // starts once this script has already minted the tag and created the release.
    function publicRun(recorded, overrides = {}) {
      return withHostPlatform("darwin", () =>
        withProcessRunner(ghDouble(recorded, overrides), () =>
          runPortablePrerelease(["--run-id", "42", "--public-release"]),
        ),
      );
    }

    it("refuses a commit that is not contained in the integration branch", () => {
      const recorded = [];
      expect(() =>
        publicRun(recorded, {
          answers: [["compare/dev...", JSON.stringify({ status: "diverged" })]],
        }),
      ).toThrow(/not contained in dev/u);
      expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
      expect(recorded.some((line) => line.includes("git/refs"))).toBe(false);
    });

    it("refuses a commit whose required checks have not passed", () => {
      const recorded = [];
      expect(() =>
        publicRun(recorded, {
          answers: [["compare/dev...", JSON.stringify({ status: "behind" })]],
          failures: [["verify-release-required-checks", "ci is failing"]],
        }),
      ).toThrow(/required checks have not passed/u);
      expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
    });

    it("refuses to publish from a checkout that is not the built commit", () => {
      // The required checks cover the built commit, not the code making the publication decision.
      // A different checkout with the same package version would otherwise mint the stable tag and
      // the Latest release from unverified local code.
      const recorded = [];
      expect(() => publicRun(recorded, { head: "0000000" })).toThrow(
        /is at 0000000, not the built commit/u,
      );
      expect(recorded.some((line) => line.includes("git/refs"))).toBe(false);
    });

    it("refuses to publish from a dirty checkout", () => {
      const recorded = [];
      expect(() => publicRun(recorded, { dirty: " M scripts/release-publish.mjs\n" })).toThrow(
        /uncommitted changes/u,
      );
      expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
    });

    it("refuses to publish when the release-owner approval does not verify live", () => {
      // This producer exposes the customer downloads BEFORE the npm publisher runs its own live
      // approval check, so a stale or fabricated catalog approval would otherwise reach the public
      // first. The same gate is brought forward rather than trusted from the catalog's own fields.
      const recorded = [];
      expect(() =>
        publicRun(recorded, {
          answers: [["compare/dev...", JSON.stringify({ status: "behind" })]],
          failures: [["check-release-impact", "release-impact: FAIL - approval not verified"]],
        }),
      ).toThrow(/release-owner approval for this version did not verify/u);
      expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
    });

    it("refuses when the release-branch lookup does not resolve either way", () => {
      // Absent is not the same as unknown. Treating an auth, rate-limit or network failure as
      // "the release branch does not exist" would silently move release authority to the default
      // branch while the configured one was alive.
      const recorded = [];
      expect(() =>
        publicRun(recorded, { branchLookupError: "gh: API rate limit exceeded" }),
      ).toThrow(/did not resolve/u);
      expect(recorded.some((line) => line.includes("git/refs"))).toBe(false);
    });

    it("publishes at the exact stable tag as the latest release once the source is approved", () => {
      const recorded = [];
      publicRun(recorded, {
        answers: [["compare/dev...", JSON.stringify({ status: "behind" })]],
      });

      const createLine = recorded.find((line) => line.startsWith("gh release create"));
      expect(createLine).toContain(`v${localVersion}`);
      expect(createLine).toContain("--latest");
      expect(createLine).not.toContain("--prerelease");
      // The evidence the npm publisher re-verifies before it promotes the dist-tag.
      expect(createLine).toContain("keiko-portable-evaluation-manifest.json");
    });

    it("supersedes the greatest governed beta when the stable release goes public", () => {
      // Without this the last evaluation beta keeps presenting itself with no pointer to the
      // stable Latest release (Codex finding on #3054).
      const recorded = [];
      publicRun(recorded, {
        answers: [["compare/dev...", JSON.stringify({ status: "behind" })]],
      });

      expect(recorded.some((line) => line.startsWith(`gh release edit ${previousTag}`))).toBe(true);
    });

    it("resolves the release-owner allowlist from the repository variable for a local run", () => {
      // The workflow injects KEIKO_RELEASE_OWNER_GITHUB_LOGINS; a local operator shell does not.
      // The producer resolves the same variable itself instead of letting the approval verifier
      // refuse every approval over an empty allowlist (Codex finding on #3054).
      const recorded = [];
      const saved = process.env.KEIKO_RELEASE_OWNER_GITHUB_LOGINS;
      delete process.env.KEIKO_RELEASE_OWNER_GITHUB_LOGINS;
      try {
        publicRun(recorded, {
          answers: [["compare/dev...", JSON.stringify({ status: "behind" })]],
        });
        expect(
          recorded.some((line) =>
            line.includes("/actions/variables/KEIKO_RELEASE_OWNER_GITHUB_LOGINS"),
          ),
        ).toBe(true);
      } finally {
        if (saved !== undefined) process.env.KEIKO_RELEASE_OWNER_GITHUB_LOGINS = saved;
      }
    });

    it("refuses a public release from a run that did not conclude entirely successfully", () => {
      // The npm publisher re-verifies the recorded run and requires conclusion "success"; a
      // lenient producer would mint a customer-visible release the documented promotion step can
      // never accept (Codex finding on #3054). Betas keep the job-scoped rule.
      const recorded = [];
      expect(() =>
        publicRun(recorded, {
          answers: [
            ["compare/dev...", JSON.stringify({ status: "behind" })],
            [
              "--json status,conclusion,headSha",
              JSON.stringify({
                status: "completed",
                conclusion: "failure",
                headSha: "b2e3900a",
                event: "workflow_dispatch",
                headBranch: "dev",
                workflowDatabaseId: 7,
                attempt: 1,
              }),
            ],
          ],
        }),
      ).toThrow(/a public release requires an entirely successful run/u);
      expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
      expect(recorded.some((line) => line.includes("git/refs"))).toBe(false);
    });

    it("encodes the release-source branch as one path parameter", () => {
      // A branch like release/0.3 embedded raw splits into two path segments, 404s, and silently
      // hands release authority to the default branch (Codex finding on #3054).
      const recorded = [];
      publicRun(recorded, {
        releaseBranchExists: true,
        answers: [["compare/release%2F0.3...", JSON.stringify({ status: "behind" })]],
      });
      expect(recorded.some((line) => line.includes("branches/release%2F0.3"))).toBe(true);
      expect(recorded.some((line) => line.includes("compare/release%2F0.3..."))).toBe(true);
    });

    it("refuses when the release-owner allowlist does not resolve", () => {
      const recorded = [];
      const saved = process.env.KEIKO_RELEASE_OWNER_GITHUB_LOGINS;
      delete process.env.KEIKO_RELEASE_OWNER_GITHUB_LOGINS;
      try {
        expect(() =>
          publicRun(recorded, {
            answers: [["compare/dev...", JSON.stringify({ status: "behind" })]],
            allowlistUnavailable: true,
          }),
        ).toThrow(/allowlist did not resolve/u);
        expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
        expect(recorded.some((line) => line.includes("git/refs"))).toBe(false);
      } finally {
        if (saved !== undefined) process.env.KEIKO_RELEASE_OWNER_GITHUB_LOGINS = saved;
      }
    });

    it("refuses a public release on a non-darwin host instead of skipping the seal proof", () => {
      // A beta reports the skip to a tester; a PUBLIC release asserts sealed bundles to a
      // customer, so a seal that never ran must refuse — the beta.0 "damaged" regression must
      // not reach the Latest release through a non-darwin publisher (Codex finding on #3054).
      const recorded = [];
      expect(() =>
        withHostPlatform("linux", () =>
          withProcessRunner(
            ghDouble(recorded, {
              answers: [["compare/dev...", JSON.stringify({ status: "behind" })]],
            }),
            () => runPortablePrerelease(["--run-id", "42", "--public-release"]),
          ),
        ),
      ).toThrow(/must not assert seals it never proved/u);
      expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
      expect(recorded.some((line) => line.includes("git/refs"))).toBe(false);
    });

    it("refuses when the run moves to a new attempt while publishing", () => {
      // Bytes, artifact ids and the recorded attempt must describe ONE execution: a rerun in the
      // publish window would blend the old attempt number with the rerun's artifacts (Codex
      // finding on #3055).
      const recorded = [];
      expect(() =>
        publicRun(recorded, {
          answers: [
            ["compare/dev...", JSON.stringify({ status: "behind" })],
            ["--json attempt", '{"attempt":2}'],
          ],
        }),
      ).toThrow(/moved to attempt 2 while publishing/u);
      expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
    });

    it("keeps an allowlist the environment already provides", () => {
      const recorded = [];
      const saved = process.env.KEIKO_RELEASE_OWNER_GITHUB_LOGINS;
      process.env.KEIKO_RELEASE_OWNER_GITHUB_LOGINS = "release-owner";
      try {
        publicRun(recorded, {
          answers: [["compare/dev...", JSON.stringify({ status: "behind" })]],
        });
        expect(
          recorded.some((line) =>
            line.includes("/actions/variables/KEIKO_RELEASE_OWNER_GITHUB_LOGINS"),
          ),
        ).toBe(false);
      } finally {
        if (saved === undefined) delete process.env.KEIKO_RELEASE_OWNER_GITHUB_LOGINS;
        else process.env.KEIKO_RELEASE_OWNER_GITHUB_LOGINS = saved;
      }
    });
  });

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
    // Draft-first: the create is NOT the publish — the release goes public only through the
    // final --draft=false edit, after the supersede edit landed (review finding on #3037).
    expect(createLine).toContain("--draft");
    // The tag binds to the exact commit the workflow built, never a moving branch ref — and it
    // is bound ATOMICALLY through a git/refs POST before the release exists, with the create
    // only verifying the tag is still there (review findings on #3032/#3037; relocated from the
    // former --target pin, which bound only a not-yet-existing tag).
    const tagPostIndex = recorded.findIndex(
      (line) =>
        line.includes("git/refs") &&
        line.includes(`ref=refs/tags/${currentTag}`) &&
        line.includes("sha=b2e3900a"),
    );
    // ORDER is the property: the tag binds to the built commit BEFORE the release exists, so
    // --verify-tag cannot re-bind assets to a moved tag (review finding on #3037).
    expect(tagPostIndex).toBeGreaterThanOrEqual(0);
    expect(tagPostIndex).toBeLessThan(recorded.indexOf(createLine));
    expect(createLine).toContain("--verify-tag");
    expect(createLine).not.toContain("--target");
    // The built commit's manifest was read at the exact head sha the run reports — the version
    // binding judges the BUILT commit, not the local checkout alone (review finding on #3037).
    expect(recorded.some((line) => line.includes("contents/package.json?ref=b2e3900a"))).toBe(true);
    // Exactly the four-asset publish set, by name — the behavioral twin of the former source pin.
    expect(createLine).toContain("keiko-macos-arm64.zip");
    expect(createLine).toContain("keiko-macos-x64.zip");
    expect(createLine).toContain("keiko-windows-x64.zip");
    expect(createLine).toContain("keiko-windows-x64-setup.exe");
    // The predecessor got the superseded pointer prepended BEFORE the draft went public:
    // create (draft), then supersede edit, then --draft=false, in exactly that order.
    const createIndex = recorded.findIndex((line) => line.startsWith("gh release create"));
    const supersedeIndex = recorded.findIndex((line) =>
      line.startsWith(`gh release edit ${previousTag}`),
    );
    const publishIndex = recorded.findIndex((line) =>
      line.startsWith(`gh release edit ${currentTag} --draft=false`),
    );
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(supersedeIndex).toBeGreaterThan(createIndex);
    expect(publishIndex).toBeGreaterThan(supersedeIndex);
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

  it("never leaves draft state when the predecessor supersede edit fails", () => {
    // Review finding on #3037: the release used to be public before the supersede edit ran, so a
    // transient edit failure left a live release without its superseded pointer — and no retry,
    // because the existing tag was refused up front. Draft-first: the create carries --draft and
    // a failing supersede aborts BEFORE any --draft=false publish is recorded.
    const recorded = [];
    const doubleBase = ghDouble(recorded);
    const failingSupersede = (command, args, options) => {
      const line = [command.split("/").pop(), ...args].join(" ");
      if (line.startsWith(`gh release edit ${previousTag}`)) {
        recorded.push(line);
        return { status: 1, stdout: "", stderr: "transient 502" };
      }
      return doubleBase(command, args, options);
    };

    expect(() =>
      withHostPlatform("darwin", () =>
        withProcessRunner(failingSupersede, () =>
          runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
        ),
      ),
    ).toThrowError(/exited 1: transient 502/u);
    const createLine = recorded.find((line) => line.startsWith("gh release create"));
    expect(createLine).toContain("--draft");
    expect(recorded.some((line) => line.includes("--draft=false"))).toBe(false);
  });

  it("resumes over an interrupted draft: deletes it and recreates the release fresh", () => {
    // Review finding on #3037: a run that died between create and publish leaves a DRAFT carrying
    // the target tag. The old code refused the tag outright, making the interruption permanent —
    // a draft was never public, so the resume deletes it and proceeds with a fresh create.
    const recorded = [];
    const overrides = {
      answers: [
        [
          "repos/{owner}/{repo}/releases?per_page",
          JSON.stringify([{ tag_name: previousTag }, { tag_name: currentTag }]),
        ],
        [`release view ${currentTag}`, '{"isDraft":true}'],
      ],
    };
    withHostPlatform("darwin", () =>
      withProcessRunner(ghDouble(recorded, overrides), () =>
        runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
      ),
    );

    const deleteIndex = recorded.findIndex((line) =>
      line.startsWith(`gh release delete ${currentTag} --yes`),
    );
    const createIndex = recorded.findIndex((line) => line.startsWith("gh release create"));
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThan(deleteIndex);
    expect(
      recorded.some((line) => line.startsWith(`gh release edit ${currentTag} --draft=false`)),
    ).toBe(true);
  });

  it("plan-only over an interrupted draft mutates nothing and states the pending recovery", () => {
    // Review finding on #3037: the draft deletion used to run before the plan-only branch, so a
    // --plan-only PREVIEW of a recovery permanently deleted the interrupted draft. A plan-only
    // run must mutate nothing — it states that publishing would delete and recreate the draft.
    const recorded = [];
    const stdout = [];
    const overrides = {
      answers: [
        [
          "repos/{owner}/{repo}/releases?per_page",
          JSON.stringify([{ tag_name: previousTag }, { tag_name: currentTag }]),
        ],
        [`release view ${currentTag}`, '{"isDraft":true}'],
      ],
    };
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    try {
      withHostPlatform("darwin", () =>
        withProcessRunner(ghDouble(recorded, overrides), () =>
          runPortablePrerelease(["--plan-only", "--run-id", "42", "--tag", currentTag]),
        ),
      );
    } finally {
      write.mockRestore();
    }

    expect(recorded.some((line) => line.startsWith("gh release delete"))).toBe(false);
    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
    expect(stdout.join("")).toContain(
      `the interrupted draft ${currentTag} would be deleted and recreated`,
    );
  });

  it("refuses when the tag already exists as a git ref at a different commit", () => {
    // Review finding on #3037: `gh release create --target` binds only a tag that does NOT yet
    // exist — an existing tag ref wins silently and the fresh assets would attach to that tag's
    // OLD commit. The old code published exactly that; the remote ref is now resolved first and
    // a mismatch refuses before anything is created.
    const recorded = [];
    const overrides = {
      failures: [
        ["POST repos/{owner}/{repo}/git/refs", "Validation Failed: Reference already exists"],
      ],
      answers: [
        [
          `git/ref/tags/${currentTag}`,
          '{"ref":"refs/tags/x","object":{"type":"commit","sha":"0ldc0mm17"}}',
        ],
      ],
    };

    expect(() =>
      withHostPlatform("darwin", () =>
        withProcessRunner(ghDouble(recorded, overrides), () =>
          runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
        ),
      ),
    ).toThrowError(/already exists as a git ref at 0ldc0mm17/u);
    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
  });

  it("proceeds when the existing tag ref already points at the built commit", () => {
    const recorded = [];
    const overrides = {
      failures: [
        ["POST repos/{owner}/{repo}/git/refs", "Validation Failed: Reference already exists"],
      ],
      answers: [[`git/ref/tags/${currentTag}`, '{"object":{"type":"commit","sha":"b2e3900a"}}']],
    };
    withHostPlatform("darwin", () =>
      withProcessRunner(ghDouble(recorded, overrides), () =>
        runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
      ),
    );

    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(true);
  });

  it("peels an annotated tag ref and proceeds when it seals the built commit", () => {
    // An annotated tag ref points at a TAG object, not the commit — without the peel the
    // comparison would judge the tag object's own sha and wrongly refuse a matching tag.
    const recorded = [];
    const overrides = {
      failures: [
        ["POST repos/{owner}/{repo}/git/refs", "Validation Failed: Reference already exists"],
      ],
      answers: [
        [`git/ref/tags/${currentTag}`, '{"object":{"type":"tag","sha":"a66tag0b"}}'],
        ["git/tags/a66tag0b", '{"object":{"type":"commit","sha":"b2e3900a"}}'],
      ],
    };
    withHostPlatform("darwin", () =>
      withProcessRunner(ghDouble(recorded, overrides), () =>
        runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
      ),
    );

    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(true);
  });

  it("refuses an annotated tag ref that peels to a different commit", () => {
    const recorded = [];
    const overrides = {
      failures: [
        ["POST repos/{owner}/{repo}/git/refs", "Validation Failed: Reference already exists"],
      ],
      answers: [
        [`git/ref/tags/${currentTag}`, '{"object":{"type":"tag","sha":"a66tag0b"}}'],
        ["git/tags/a66tag0b", '{"object":{"type":"commit","sha":"0ther5ha"}}'],
      ],
    };

    expect(() =>
      withHostPlatform("darwin", () =>
        withProcessRunner(ghDouble(recorded, overrides), () =>
          runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
        ),
      ),
    ).toThrowError(/already exists as a git ref at 0ther5ha/u);
    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
  });

  it("still refuses a tag that exists as a PUBLISHED release", () => {
    const recorded = [];
    const overrides = {
      answers: [
        [
          "repos/{owner}/{repo}/releases?per_page",
          JSON.stringify([{ tag_name: previousTag }, { tag_name: currentTag }]),
        ],
        [`release view ${currentTag}`, '{"isDraft":false}'],
      ],
    };

    expect(() =>
      withProcessRunner(ghDouble(recorded, overrides), () =>
        runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
      ),
    ).toThrowError(/already exists/u);
    expect(recorded.some((line) => line.startsWith("gh release delete"))).toBe(false);
    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
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

  it("refuses to bind when two unseen dispatch runs race on the same ref", () => {
    // Review finding on #3037: when a second operator dispatches the same workflow on the same
    // ref concurrently, BOTH new run ids are absent from the pre-dispatch set. gh cannot return
    // the created run id, so the two runs are indistinguishable — the old `.find()` selection
    // bound one anyway and could publish the competing operator's assets. The only safe outcome
    // is a refusal that names the ambiguity; never a guess.
    const recorded = [];
    const waits = [];
    let listCalls = 0;
    const doubleBase = ghDouble(recorded);
    const racing = (command, args, options) => {
      if (args.join(" ").startsWith("run list")) {
        listCalls += 1;
        return {
          status: 0,
          stdout:
            listCalls === 1
              ? '[{"databaseId":41}]'
              : '[{"databaseId":41},{"databaseId":43},{"databaseId":44}]',
          stderr: "",
        };
      }
      return doubleBase(command, args, options);
    };

    expect(() =>
      withSleeper(
        (ms) => waits.push(ms),
        () =>
          withHostPlatform("darwin", () =>
            withProcessRunner(racing, () => runPortablePrerelease(["--tag", currentTag])),
          ),
      ),
    ).toThrowError(/concurrent dispatch/u);
    // Neither candidate run was bound, and nothing was published.
    expect(recorded.some((line) => line.startsWith("gh run view"))).toBe(false);
    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(false);
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

  it("resumes the interrupted draft by default instead of allocating the next beta", () => {
    // Review finding on #3037: a crash between create and publish leaves beta.N as a draft; an
    // ordinary retry WITHOUT --tag counted that draft as existing, allocated N+1, picked the
    // still-private N as predecessor, and left the live N-1 unsuperseded. The default now
    // resumes the highest existing beta when it is a draft.
    const recorded = [];
    const overrides = {
      answers: [
        [`release view ${currentTag}`, '{"isDraft":true}'],
        [
          "repos/{owner}/{repo}/releases?per_page",
          JSON.stringify([{ tag_name: previousTag }, { tag_name: currentTag }]),
        ],
      ],
    };
    withHostPlatform("darwin", () =>
      withProcessRunner(ghDouble(recorded, overrides), () =>
        runPortablePrerelease(["--run-id", "42"]),
      ),
    );

    // The resumed draft is deleted and recreated under ITS tag — not the next number.
    expect(recorded.some((line) => line.startsWith(`gh release delete ${currentTag}`))).toBe(true);
    const createLine = recorded.find((line) => line.startsWith("gh release create"));
    expect(createLine).toContain(currentTag);
    // The live predecessor still gets its superseding pointer.
    expect(recorded.some((line) => line.startsWith(`gh release edit ${previousTag}`))).toBe(true);
  });

  it("refuses a --tag override below the highest existing beta", () => {
    // Review finding on #3037: publishing beta.5 while beta.9 exists would make the NEWEST
    // release an older number and leave the real highest beta unsuperseded — the prerelease
    // lineage must stay monotonic. Resuming the highest beta's own draft stays allowed.
    const lowTag = `v${localVersion}-beta.5`;
    const overrides = {
      answers: [
        [
          "repos/{owner}/{repo}/releases?per_page",
          JSON.stringify([{ tag_name: `v${localVersion}-beta.9` }]),
        ],
      ],
    };

    expect(() =>
      withHostPlatform("darwin", () =>
        withProcessRunner(ghDouble([], overrides), () =>
          runPortablePrerelease(["--run-id", "42", "--tag", lowTag]),
        ),
      ),
    ).toThrowError(/below the existing v.+-beta\.9/u);
  });

  it("refuses a supplied run built from another branch", () => {
    // Review finding on #3037: --run-id could name a successful evaluation run of an UNMERGED
    // feature branch whose package version matches the local checkout — every downstream check
    // passed and fresh branch bytes published publicly. The run must be a workflow_dispatch on
    // exactly the requested ref.
    const overrides = {
      answers: [
        [
          "--json status,conclusion,headSha",
          '{"status":"completed","conclusion":"success","headSha":"b2e3900a","event":"workflow_dispatch","headBranch":"feat/unmerged"}',
        ],
      ],
    };

    expect(() =>
      withProcessRunner(ghDouble([], overrides), () =>
        runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
      ),
    ).toThrowError(/built branch feat\/unmerged, not the requested ref dev/u);
  });

  it("refuses a supplied run that was not a workflow_dispatch", () => {
    const overrides = {
      answers: [
        [
          "--json status,conclusion,headSha",
          '{"status":"completed","conclusion":"success","headSha":"b2e3900a","event":"push","headBranch":"dev"}',
        ],
      ],
    };

    expect(() =>
      withProcessRunner(ghDouble([], overrides), () =>
        runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
      ),
    ).toThrowError(/is a push run, not the workflow_dispatch/u);
  });

  it("refuses a supplied run from a different workflow on the same branch", () => {
    // Review finding on #3037: another workflow_dispatch workflow on the requested branch can
    // expose identically named staging jobs and artifacts — the ref/event checks alone would
    // publish its bytes. The run must belong to the portable-assets workflow itself, compared
    // by database id resolved from the workflow path.
    const overrides = {
      answers: [
        [
          "--json status,conclusion,headSha",
          '{"status":"completed","conclusion":"success","headSha":"b2e3900a","event":"workflow_dispatch","headBranch":"dev","workflowDatabaseId":999}',
        ],
      ],
    };

    expect(() =>
      withProcessRunner(ghDouble([], overrides), () =>
        runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
      ),
    ).toThrowError(/belongs to workflow 999, not \.github\/workflows\/portable-assets\.yml/u);
  });

  it("refuses to publish when the tag moved after the draft was created", () => {
    // Review finding on #3037: a draft's tag stays mutable until publication and --verify-tag
    // at create time only proves existence — the publication boundary re-reads the ref and
    // refuses when it no longer points at the built commit.
    const recorded = [];
    const overrides = {
      answers: [
        [
          "api repos/{owner}/{repo}/git/ref/tags/",
          '{"ref":"refs/tags/x","object":{"type":"commit","sha":"deadbeef"}}',
        ],
      ],
    };

    expect(() =>
      withHostPlatform("darwin", () =>
        withProcessRunner(ghDouble(recorded, overrides), () =>
          runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
        ),
      ),
    ).toThrowError(/moved to deadbeef after the draft was created/u);
    // The draft was created but never went public — it remains resumable, nothing was exposed.
    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(true);
    expect(recorded.some((line) => line.includes("--draft=false"))).toBe(false);
  });

  it("refuses to publish when the tag vanished before publication", () => {
    // The release was created without --target, so publishing over a vanished tag would re-mint
    // it at the default branch head — the built-commit binding would silently break.
    const recorded = [];
    const overrides = {
      failures: [["api repos/{owner}/{repo}/git/ref/tags/", "gh: Not Found (HTTP 404)"]],
    };

    expect(() =>
      withHostPlatform("darwin", () =>
        withProcessRunner(ghDouble(recorded, overrides), () =>
          runPortablePrerelease(["--run-id", "42", "--tag", currentTag]),
        ),
      ),
    ).toThrowError(/vanished before publication/u);
    expect(recorded.some((line) => line.includes("--draft=false"))).toBe(false);
  });

  it("refuses to publish from a cancelled run", () => {
    const overrides = {
      answers: [
        [
          "--json status,conclusion,headSha",
          '{"status":"completed","conclusion":"cancelled","headSha":"x","event":"workflow_dispatch","headBranch":"dev","workflowDatabaseId":7}',
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
              : '{"status":"completed","conclusion":"success","headSha":"b2e3900a","event":"workflow_dispatch","headBranch":"dev","workflowDatabaseId":7}',
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
    const overrides = { answers: [["repos/{owner}/{repo}/releases?per_page", "[]"]] };
    withHostPlatform("darwin", () =>
      withProcessRunner(ghDouble(recorded, overrides), () =>
        runPortablePrerelease(["--run-id", "42", "--tag", `v${localVersion}-beta.0`]),
      ),
    );

    expect(recorded.some((line) => line.startsWith("gh release create"))).toBe(true);
    // The only edit is the release's own --draft=false publish — no predecessor supersede edit.
    expect(
      recorded.some((line) => line.startsWith("gh release edit") && line.includes("--notes-file")),
    ).toBe(false);
    expect(
      recorded.some((line) =>
        line.startsWith(`gh release edit v${localVersion}-beta.0 --draft=false`),
      ),
    ).toBe(true);
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

    // No supersede edit for the predecessor — only the release's own --draft=false publish.
    expect(recorded.some((line) => line.startsWith(`gh release edit ${previousTag}`))).toBe(false);
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
