import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { URL, fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  CLASSIFICATION,
  INFRA_ANNOTATION_SIGNATURES,
  OBSERVER_WORKFLOW_PATH,
  RERUN_ELIGIBLE_WORKFLOW_PATHS,
  classifyJob,
  classifyRun,
  collectObservation,
  executeInfraFailureCli,
  ghApi,
  isFailedJob,
  matchedInfraSignature,
  parseObserverOptions,
  renderDecisionSummary,
  requestRerun,
  requireRepositorySlug,
  requireRunId,
  runObserver,
} from "../check-infra-failure-signature.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OBSERVER_WORKFLOW = resolve(repoRoot, OBSERVER_WORKFLOW_PATH);
const ALLOWLISTED_LANE = ".github/workflows/ci.yml";

// Every fixture below is a redacted capture of a real GitHub REST payload; provenance and the reason
// each one exists are recorded in the fixture's own `provenance` block.
function fixture(name) {
  const url = new URL(`./fixtures/infra-failure-signature/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

const infraRun = fixture("infra-run-allowlisted");
const observedInfraRun = fixture("infra-run-observed");
const genuineRun = fixture("genuine-run");
const mixedRun = fixture("mixed-run");
const zeroStepWithoutAnnotation = fixture("zero-step-without-annotation");
const concurrencyCancelledRun = fixture("concurrency-cancelled-run");

function withRun(observation, run) {
  return { ...observation, run: { ...observation.run, ...run } };
}

function failedJobOf(observation) {
  const job = observation.jobs.find(isFailedJob);
  return { job, annotations: observation.annotations[String(job.id)] };
}

describe("infrastructure-failure signature classification", () => {
  it("classifies a run whose every failed job executed zero steps under a pinned signature as infra", () => {
    const decision = classifyRun(infraRun);

    expect(decision).toMatchObject({
      classification: CLASSIFICATION.infra,
      decision: "rerun",
      runId: 30157827347,
      runAttempt: 1,
      workflowPath: ALLOWLISTED_LANE,
      failedJobCount: 1,
      infraJobCount: 1,
      signatures: ["runner-internal-error"],
    });
  });

  it("classifies a genuinely red run as genuine even though it is on an allowlisted lane", () => {
    const decision = classifyRun(genuineRun);

    expect(decision).toMatchObject({
      classification: CLASSIFICATION.genuine,
      decision: "no-action",
      workflowPath: ALLOWLISTED_LANE,
      failedJobCount: 4,
      infraJobCount: 0,
      signatures: [],
    });
  });

  it("classifies a mixed run as genuine because rerun-failed-jobs would re-execute the genuine job", () => {
    const decision = classifyRun(mixedRun);

    expect(decision).toMatchObject({
      classification: CLASSIFICATION.genuine,
      decision: "no-action",
      failedJobCount: 2,
      infraJobCount: 1,
    });
  });

  it("never re-runs a run that already carries a second attempt", () => {
    for (const attempt of [2, 3, 17]) {
      expect(classifyRun(withRun(infraRun, { run_attempt: attempt }))).toMatchObject({
        classification: CLASSIFICATION.alreadyAttempted,
        decision: "no-action",
      });
    }
  });

  it("takes no action on its own workflow_run payload", () => {
    const decision = classifyRun(withRun(infraRun, { path: OBSERVER_WORKFLOW_PATH }));

    expect(decision).toMatchObject({
      classification: CLASSIFICATION.selfEvent,
      decision: "no-action",
    });
  });

  it("excludes every lane that is not on the path allowlist, including a rename", () => {
    const excluded = [
      ".github/workflows/nightly-perf-evidence.yml",
      ".github/workflows/mutation-security.yml",
      ".github/workflows/keiko-for-quality-action.yml",
      ".github/workflows/osv-scanner.yml",
      ".github/workflows/ci-renamed.yml",
      "dynamic/github-code-scanning/codeql",
      "ci.yml",
    ];

    for (const path of excluded) {
      expect(classifyRun(withRun(infraRun, { path }))).toMatchObject({
        classification: CLASSIFICATION.excludedLane,
        decision: "no-action",
        workflowPath: path,
      });
    }
  });

  it("excludes the incident run as observed, because its lane is deliberately not allowlisted", () => {
    expect(classifyRun(observedInfraRun)).toMatchObject({
      classification: CLASSIFICATION.excludedLane,
      decision: "no-action",
      workflowPath: ".github/workflows/keiko-for-quality-action.yml",
    });
  });

  it("fails closed on a malformed or unexpected payload", () => {
    const malformed = [
      undefined,
      null,
      42,
      {},
      { run: null },
      { run: {} },
      { run: { id: "30157827347", run_attempt: 1, path: ALLOWLISTED_LANE } },
      { run: { id: 0, run_attempt: 1, path: ALLOWLISTED_LANE } },
      { run: { id: 1, run_attempt: 0, path: ALLOWLISTED_LANE } },
      { run: { id: 1, run_attempt: 1.5, path: ALLOWLISTED_LANE } },
      { run: { id: 1, run_attempt: 1, path: "" } },
      { run: { id: 1, run_attempt: 1 } },
    ];

    for (const observation of malformed) {
      expect(classifyRun(observation)).toMatchObject({
        classification: CLASSIFICATION.genuine,
        decision: "no-action",
      });
    }
  });

  it("fails closed when the job list is missing or provably truncated", () => {
    const base = withRun(infraRun, {});

    expect(classifyRun({ ...base, jobs: undefined })).toMatchObject({
      classification: CLASSIFICATION.genuine,
      reason: "job list is missing or incomplete",
    });
    expect(classifyRun({ ...base, jobsTotal: base.jobs.length + 1 })).toMatchObject({
      classification: CLASSIFICATION.genuine,
      reason: "job list is missing or incomplete",
    });
    expect(classifyRun({ ...base, jobsTotal: "2" })).toMatchObject({
      classification: CLASSIFICATION.genuine,
      reason: "job list is missing or incomplete",
    });
  });

  it("does not treat a run without any failed job as vacuously infrastructure weather", () => {
    const decision = classifyRun({
      ...infraRun,
      jobsTotal: 1,
      jobs: [{ id: 1, name: "ci", conclusion: "success", steps: [{ conclusion: "success" }] }],
    });

    expect(decision).toMatchObject({
      classification: CLASSIFICATION.genuine,
      decision: "no-action",
      failedJobCount: 0,
      infraJobCount: 0,
      reason: "the run reports no failed job",
    });
  });

  it("treats an unknown job conclusion as failed, so it must carry the signature itself", () => {
    const infraJob = infraRun.jobs.find(isFailedJob);
    const decision = classifyRun({
      ...infraRun,
      jobsTotal: 2,
      jobs: [infraJob, { id: 7, name: "timed out", conclusion: "timed_out", steps: [] }],
    });

    expect(decision).toMatchObject({
      classification: CLASSIFICATION.genuine,
      failedJobCount: 2,
      infraJobCount: 1,
    });
  });
});

describe("per-job classification", () => {
  it("accepts the observed runner internal error", () => {
    const { job, annotations } = failedJobOf(infraRun);

    expect(classifyJob(job, annotations)).toMatchObject({
      classification: CLASSIFICATION.infra,
      signature: "runner-internal-error",
    });
  });

  it("rejects a zero-step job that carries no annotation at all", () => {
    const { job, annotations } = failedJobOf(zeroStepWithoutAnnotation);

    expect(annotations).toEqual([]);
    expect(classifyJob(job, annotations)).toMatchObject({
      classification: CLASSIFICATION.genuine,
      reason: "no pinned runner-failure signature",
    });
  });

  it("rejects a zero-step job cancelled by a higher-priority concurrency request", () => {
    const { job, annotations } = failedJobOf(concurrencyCancelledRun);

    expect(annotations[0].message).toContain("Canceling since a higher priority waiting request");
    expect(classifyJob(job, annotations)).toMatchObject({
      classification: CLASSIFICATION.genuine,
      reason: "no pinned runner-failure signature",
    });
  });

  it("rejects every failed job of a genuinely red run", () => {
    for (const job of genuineRun.jobs.filter(isFailedJob)) {
      const verdict = classifyJob(job, genuineRun.annotations[String(job.id)]);
      expect(verdict.classification).toBe(CLASSIFICATION.genuine);
      expect(verdict.reason).toMatch(/step\(s\) executed$/u);
    }
  });

  it("counts only steps that reached a terminal state", () => {
    const annotations = infraRun.annotations["89678551433"];
    const queued = { id: 1, conclusion: "failure", steps: [{ conclusion: null }, {}] };
    const ran = { id: 1, conclusion: "failure", steps: [{ conclusion: "skipped" }] };

    expect(classifyJob(queued, annotations).classification).toBe(CLASSIFICATION.infra);
    expect(classifyJob(ran, annotations)).toMatchObject({
      classification: CLASSIFICATION.genuine,
      reason: "1 step(s) executed",
    });
  });

  it("fails closed on a job with no step list and on a malformed job", () => {
    const annotations = infraRun.annotations["89678551433"];

    expect(classifyJob({ id: 1, conclusion: "failure" }, annotations)).toMatchObject({
      classification: CLASSIFICATION.genuine,
      reason: "job payload carries no step list",
    });
    expect(classifyJob(null, annotations)).toMatchObject({
      classification: CLASSIFICATION.genuine,
      reason: "job payload is malformed",
    });
  });

  it("treats a job whose conclusion is missing or non-string as failed", () => {
    expect(isFailedJob({ conclusion: "success" })).toBe(false);
    expect(isFailedJob({ conclusion: "skipped" })).toBe(false);
    expect(isFailedJob({ conclusion: "neutral" })).toBe(false);
    expect(isFailedJob({ conclusion: null })).toBe(true);
    expect(isFailedJob({})).toBe(true);
    expect(isFailedJob("job")).toBe(true);
  });
});

describe("pinned annotation signatures", () => {
  const message = "GitHub Actions has encountered an internal error when running your job.";

  it("matches the observed wording case-insensitively and without the trailing period", () => {
    expect(matchedInfraSignature([{ annotation_level: "failure", message }])).toBe(
      "runner-internal-error",
    );
    expect(
      matchedInfraSignature([
        { annotation_level: "failure", message: `  ${message.slice(0, -1).toUpperCase()}  ` },
      ]),
    ).toBe("runner-internal-error");
  });

  it("ignores the same wording at a non-failure annotation level", () => {
    expect(matchedInfraSignature([{ annotation_level: "notice", message }])).toBeUndefined();
    expect(matchedInfraSignature([{ annotation_level: "warning", message }])).toBeUndefined();
  });

  it("does not match a message that merely contains the wording", () => {
    const embedded = `Step failed. ${message} See the log.`;

    expect(matchedInfraSignature([{ annotation_level: "failure", message: embedded }])).toBe(
      undefined,
    );
  });

  it("ignores malformed annotation entries and a non-array payload", () => {
    expect(matchedInfraSignature(undefined)).toBeUndefined();
    expect(matchedInfraSignature("failure")).toBeUndefined();
    expect(matchedInfraSignature([null, 7, {}, { annotation_level: "failure" }])).toBeUndefined();
  });

  it("keeps every signature id unique so a decision record is unambiguous", () => {
    const ids = INFRA_ANNOTATION_SIGNATURES.map((signature) => signature.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("runner-internal-error");
  });
});

describe("input validation", () => {
  it("requires a repository slug of the form owner/name", () => {
    expect(requireRepositorySlug("oscharko-dev/Keiko")).toBe("oscharko-dev/Keiko");
    for (const value of [undefined, "", "Keiko", "owner/name/extra", "owner/na me", 7]) {
      expect(() => requireRepositorySlug(value)).toThrow(/repository slug/u);
    }
  });

  it("requires a positive integer run id", () => {
    expect(requireRunId(30157827347)).toBe("30157827347");
    expect(requireRunId("30157827347")).toBe("30157827347");
    for (const value of [undefined, "", "0", "-1", "1e3", "12 34", "../../etc", 0]) {
      expect(() => requireRunId(value)).toThrow(/run id/u);
    }
  });
});

describe("GitHub REST access", () => {
  const ok = { status: 0, stdout: '{"id":1}' };

  it("passes the api path through and parses the response", () => {
    const execute = vi.fn().mockReturnValue(ok);

    expect(ghApi("repos/o/r/actions/runs/1", { execute, ghExecutable: "/usr/bin/gh" })).toEqual({
      id: 1,
    });
    expect(execute).toHaveBeenCalledWith(
      "/usr/bin/gh",
      ["api", "repos/o/r/actions/runs/1"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("sends an explicit method when one is requested", () => {
    const execute = vi.fn().mockReturnValue({ status: 0, stdout: "" });

    expect(ghApi("repos/o/r/x", { execute, ghExecutable: "gh", method: "POST" })).toBeUndefined();
    expect(execute).toHaveBeenCalledWith(
      "gh",
      ["api", "--method", "POST", "repos/o/r/x"],
      expect.anything(),
    );
  });

  it("throws on a non-zero exit status and on a spawn error", () => {
    const failed = vi.fn().mockReturnValue({ status: 1, stdout: "" });
    const spawnFailure = vi.fn().mockReturnValue({ error: new Error("ENOENT"), status: null });

    expect(() => ghApi("repos/o/r/x", { execute: failed, ghExecutable: "gh" })).toThrow(
      /exited with status 1/u,
    );
    expect(() => ghApi("repos/o/r/x", { execute: spawnFailure, ghExecutable: "gh" })).toThrow(
      /ENOENT/u,
    );
  });

  it("collects annotations for failed jobs only", () => {
    const request = vi.fn((path) => {
      if (path.endsWith("/jobs?per_page=100")) {
        return {
          total_count: 2,
          jobs: [
            { id: 11, conclusion: "failure", steps: [] },
            { id: 12, conclusion: "success", steps: [] },
          ],
        };
      }
      if (path.includes("/check-runs/")) return [{ annotation_level: "failure", message: "x" }];
      return { id: 30157827347, run_attempt: 1, path: ALLOWLISTED_LANE };
    });

    const observation = collectObservation("30157827347", {
      repository: "oscharko-dev/Keiko",
      request,
    });

    expect(observation.jobsTotal).toBe(2);
    expect(Object.keys(observation.annotations)).toEqual(["11"]);
    expect(request).toHaveBeenCalledWith(
      "repos/oscharko-dev/Keiko/check-runs/11/annotations?per_page=100",
    );
  });

  it("tolerates a jobs page of an unexpected shape without inventing jobs", () => {
    const request = vi.fn().mockReturnValue("unexpected");

    expect(collectObservation(1, { repository: "o/r", request })).toMatchObject({
      jobs: [],
      jobsTotal: undefined,
      annotations: {},
    });
  });

  it("posts the run-granular re-run request exactly once", () => {
    const request = vi.fn().mockReturnValue(undefined);

    requestRerun(30157827347, { repository: "oscharko-dev/Keiko", request });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "repos/oscharko-dev/Keiko/actions/runs/30157827347/rerun-failed-jobs",
      "POST",
    );
  });

  it("refuses to build an api path from an unvalidated repository or run id", () => {
    expect(() => requestRerun(1, { repository: "../../evil", request: vi.fn() })).toThrow();
    expect(() => collectObservation("1;rm", { repository: "o/r", request: vi.fn() })).toThrow();
  });
});

describe("observer bounds", () => {
  const enforce = { mode: "enforce", input: "ignored" };
  const dryRun = { mode: "dry-run", input: "ignored" };

  function observe(options, observation) {
    const rerun = vi.fn();
    const read = vi.fn().mockReturnValue(JSON.stringify(observation));
    const result = runObserver(options, { read, rerun });
    return { ...result, rerun };
  }

  it("requests exactly one re-run for an infrastructure-signature run in enforce mode", () => {
    const { acted, rerun } = observe(enforce, infraRun);

    expect(acted).toBe(true);
    expect(rerun).toHaveBeenCalledTimes(1);
    expect(rerun.mock.calls[0][0]).toBe(30157827347);
  });

  it("never calls the re-run api in dry-run mode", () => {
    const { decision, acted, rerun } = observe(dryRun, infraRun);

    expect(decision.classification).toBe(CLASSIFICATION.infra);
    expect(acted).toBe(false);
    expect(rerun).not.toHaveBeenCalled();
  });

  it("never calls the re-run api for a genuine, mixed, excluded or retried run", () => {
    for (const observation of [
      genuineRun,
      mixedRun,
      observedInfraRun,
      withRun(infraRun, { run_attempt: 2 }),
      withRun(infraRun, { path: OBSERVER_WORKFLOW_PATH }),
    ]) {
      const { acted, rerun } = observe(enforce, observation);
      expect(acted).toBe(false);
      expect(rerun).not.toHaveBeenCalled();
    }
  });

  it("collects the observation over the network only when no input file is given", () => {
    const collect = vi.fn().mockReturnValue(infraRun);
    const read = vi.fn();

    runObserver({ mode: "dry-run", runId: "30157827347" }, { collect, read });

    expect(collect).toHaveBeenCalledWith("30157827347", expect.anything());
    expect(read).not.toHaveBeenCalled();
  });
});

describe("command line surface", () => {
  it("defaults to dry-run and rejects an unknown mode", () => {
    expect(parseObserverOptions([])).toMatchObject({ mode: "dry-run" });
    expect(parseObserverOptions(["--mode", "enforce"])).toMatchObject({ mode: "enforce" });
    expect(() => parseObserverOptions(["--mode", "force"])).toThrow(/--mode must be/u);
  });

  it("reads every option it supports", () => {
    const options = parseObserverOptions([
      "--run-id",
      "7",
      "--input",
      "bundle.json",
      "--summary",
      "summary.md",
      "--github-output",
      "out.txt",
    ]);

    expect(options).toMatchObject({
      runId: "7",
      input: "bundle.json",
      summary: "summary.md",
      output: "out.txt",
    });
  });

  it("writes the decision to the job summary and to the step outputs", () => {
    const append = vi.fn();
    const log = vi.fn();
    const setExitCode = vi.fn();

    executeInfraFailureCli({
      argv: ["--mode", "enforce", "--summary", "s.md", "--github-output", "o.txt"],
      run: () => ({ decision: classifyRun(infraRun), acted: true }),
      append,
      log,
      setExitCode,
    });

    expect(setExitCode).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("infra-failure-signature: infra / rerun");
    expect(append.mock.calls[0][0]).toBe(resolve("s.md"));
    expect(append.mock.calls[0][1]).toContain("- classification: infra");
    expect(append.mock.calls[1][1]).toContain("rerun_requested=true");
    expect(append.mock.calls[1][1]).toContain("run_id=30157827347");
  });

  it("writes nothing when no destination is requested", () => {
    const append = vi.fn();

    executeInfraFailureCli({
      argv: [],
      run: () => ({ decision: classifyRun(genuineRun), acted: false }),
      append,
      log: vi.fn(),
      setExitCode: vi.fn(),
    });

    expect(append).not.toHaveBeenCalled();
  });

  it("reports a wiring defect on stderr and exits non-zero without ever re-running", () => {
    const error = vi.fn();
    const setExitCode = vi.fn();

    executeInfraFailureCli({
      argv: ["--mode", "enforce"],
      run: () => {
        throw new Error("a positive integer run id is required");
      },
      error,
      log: vi.fn(),
      setExitCode,
    });

    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(
      "infra-failure-signature: FAIL - a positive integer run id is required",
    );
  });

  it("reports a non-Error rejection without crashing", () => {
    const error = vi.fn();

    executeInfraFailureCli({
      argv: [],
      run: () => {
        throw "broken";
      },
      error,
      log: vi.fn(),
      setExitCode: vi.fn(),
    });

    expect(error).toHaveBeenCalledWith("infra-failure-signature: FAIL - broken");
  });
});

describe("decision evidence redaction", () => {
  it("reports counts, ids, the workflow path and signature names only", () => {
    const summary = renderDecisionSummary(classifyRun(infraRun), "enforce", true);

    expect(summary).toContain("- run id: 30157827347");
    expect(summary).toContain("- failed jobs: 1");
    expect(summary).toContain("- matched signatures: runner-internal-error");
    expect(summary).toContain("- action: re-run requested for the failed jobs");
    expect(summary).not.toContain("internal error when running your job");
    expect(summary).not.toContain("Evaluate quality aggregate");
  });

  it("never leaks annotation text of a genuine run into the decision record", () => {
    const summary = renderDecisionSummary(classifyRun(genuineRun), "enforce", false);
    const messages = Object.values(genuineRun.annotations).flat();

    expect(messages.length).toBeGreaterThan(0);
    for (const annotation of messages) expect(summary).not.toContain(annotation.message);
    expect(summary).toContain("- matched signatures: none");
    expect(summary).toContain("- action: no action");
  });

  it("renders an unknown run without inventing values", () => {
    const summary = renderDecisionSummary(classifyRun(undefined), "dry-run", false);

    expect(summary).toContain("- run id: unknown");
    expect(summary).toContain("- workflow path: unknown");
    expect(summary).toContain("- run attempt: unknown");
    expect(summary).toContain("- classification: genuine");
  });

  it("never reports a job count it did not measure", () => {
    // A lane, attempt or payload rejection short-circuits before any job is counted. Printing "0"
    // there would assert something the observer never looked at.
    for (const run of [
      { path: ".github/workflows/nightly-perf-evidence.yml" },
      { path: OBSERVER_WORKFLOW_PATH },
      { run_attempt: 2 },
    ]) {
      const decision = classifyRun(withRun(infraRun, run));
      expect(decision).toMatchObject({
        failedJobCount: null,
        infraJobCount: null,
        signatures: null,
      });

      const summary = renderDecisionSummary(decision, "enforce", false);
      expect(summary).toContain("- failed jobs: not evaluated");
      expect(summary).toContain("- infrastructure-signature jobs: not evaluated");
      expect(summary).toContain("- matched signatures: not evaluated");
    }
  });

  it("reports the measured counts once the jobs were actually classified", () => {
    const summary = renderDecisionSummary(classifyRun(mixedRun), "enforce", false);

    expect(summary).toContain("- failed jobs: 2");
    expect(summary).toContain("- infrastructure-signature jobs: 1");
    expect(summary).toContain("- matched signatures: runner-internal-error");
  });
});

describe("observer workflow wiring", () => {
  const workflow = readFileSync(OBSERVER_WORKFLOW, "utf8");

  // The `workflows:` trigger keys on display names while the classifier keys on file paths. Reading
  // both out of the committed files is what stops a rename from silently unhooking a lane.
  const observedWorkflowNames = [
    ...(/\n {4}workflows:\n((?: {6}(?:#[^\n]*|- [^\n]+)\n)+)/u.exec(workflow)?.[1] ?? "").matchAll(
      /^ {6}- (.+)$/gmu,
    ),
  ].map((match) => match[1]);

  function displayNameOf(path) {
    const declared = /^name:\s*(.+)$/mu.exec(readFileSync(resolve(repoRoot, path), "utf8"));
    return declared?.[1];
  }

  it("declares the deny-all default and elevates only actions: write on the one job", () => {
    const grants = workflow.split("\n").filter((line) => /^\s+[a-z-]+: (write|read)$/u.test(line));

    expect(workflow).toContain("\npermissions: {}\n");
    // `checks: read` is not optional: the annotations the classifier matches live on the Checks API,
    // which `actions: *` does not reach. Without it every job classifies `genuine` for want of a
    // signature it could not see - fail-closed, and still a defect. `actions: write` stays the only
    // write grant.
    expect(grants).toEqual(["      actions: write", "      checks: read", "      contents: read"]);
    expect(grants.filter((line) => line.endsWith(": write"))).toHaveLength(1);
  });

  it("observes completed runs and skips its own file path with the classifier's own key", () => {
    expect(workflow).toMatch(/^ {2}workflow_run:$/mu);
    expect(workflow).toContain("    types:\n      - completed\n");
    expect(workflow).toContain(`github.event.workflow_run.path != '${OBSERVER_WORKFLOW_PATH}'`);
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'failure'");
  });

  it("observes every allowlisted lane, matching the display name its file declares", () => {
    for (const path of RERUN_ELIGIBLE_WORKFLOW_PATHS) {
      expect(observedWorkflowNames).toContain(displayNameOf(path));
    }
  });

  it("observes the excluded wall-clock lanes so their exclusion is recorded, not silent", () => {
    for (const path of [
      ".github/workflows/nightly-perf-evidence.yml",
      ".github/workflows/mutation-security.yml",
      ".github/workflows/osv-scanner.yml",
    ]) {
      expect(observedWorkflowNames).toContain(displayNameOf(path));
      expect(RERUN_ELIGIBLE_WORKFLOW_PATHS.has(path)).toBe(false);
      expect(classifyRun(withRun(infraRun, { path }))).toMatchObject({
        classification: CLASSIFICATION.excludedLane,
        decision: "no-action",
      });
    }
  });

  it("names only workflows that exist, so a rename cannot leave a dangling trigger", () => {
    const declared = new Map(
      readdirSync(resolve(repoRoot, ".github", "workflows"))
        .filter((file) => file.endsWith(".yml"))
        .map((file) => [displayNameOf(`.github/workflows/${file}`), file]),
    );

    expect(observedWorkflowNames.length).toBeGreaterThan(0);
    for (const name of observedWorkflowNames) expect(declared.has(name)).toBe(true);
  });

  it("runs the classifier in enforce mode and dispatches in dry-run mode by default", () => {
    expect(workflow).toContain("node scripts/check-infra-failure-signature.mjs");
    expect(workflow).toContain("|| 'enforce' }}");
    expect(workflow).toContain("        default: dry-run\n");
  });

  it("checks out the default branch rather than the observed run's head", () => {
    expect(workflow).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(workflow).not.toMatch(/^\s*ref:\s*\$\{\{[^}]*head_sha/mu);
    expect(workflow).toContain("persist-credentials: false");
  });

  it("pins every action to a full commit SHA and bounds the job", () => {
    const uses = [...workflow.matchAll(/uses:\s*(\S+)/gu)].map((match) => match[1]);

    expect(uses.length).toBeGreaterThan(0);
    for (const reference of uses) expect(reference).toMatch(/@[0-9a-f]{40}$/u);
    expect(workflow).toMatch(/^ {4}timeout-minutes: \d+$/mu);
  });

  it("passes the run id and mode through env indirection, never into the run body", () => {
    expect(workflow).toContain('--run-id "$OBSERVED_RUN_ID"');
    expect(workflow).toContain('--mode "$OBSERVER_MODE"');
    expect(workflow).not.toMatch(/run: \|[\s\S]*\$\{\{/u);
  });

  it("keeps the allowlisted lanes pointing at workflow files that exist", () => {
    for (const path of RERUN_ELIGIBLE_WORKFLOW_PATHS) {
      expect(() => readFileSync(resolve(repoRoot, path), "utf8")).not.toThrow();
    }
    expect(RERUN_ELIGIBLE_WORKFLOW_PATHS.has(OBSERVER_WORKFLOW_PATH)).toBe(false);
  });
});
