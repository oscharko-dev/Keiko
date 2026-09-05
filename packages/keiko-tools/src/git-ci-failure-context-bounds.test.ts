import { describe, expect, it, vi } from "vitest";
import { readGitCiFailureContext } from "./git-ci-failure-context.js";
import {
  ANNOTATION,
  BASE,
  CHECK,
  JOB,
  WORKFLOW,
  checkValue,
  failureFacts,
  failureRunner,
  response,
  workflowFacts,
  workflowRunner,
} from "./git-ci-failure-context-test-support.js";
import type { CommandResult } from "./types.js";

function request(): {
  facts: ReturnType<typeof workflowFacts>;
  run: ReturnType<typeof workflowRunner>;
  stillAuthorized: () => boolean;
} {
  return { facts: workflowFacts(), run: workflowRunner(), stillAuthorized: (): boolean => true };
}
describe("required failed workflow diagnostic summaries", () => {
  it("pins jobs to the observed attempt and exposes failed jobs/steps only", async () => {
    const input = request();
    const result = await readGitCiFailureContext(input);
    expect(result).toMatchObject({
      status: "observed",
      context: {
        sourceCount: 1,
        entries: [
          { kind: "job", sourceId: 200, jobId: 300 },
          { kind: "step", text: "Compile source" },
        ],
        completeness: { complete: true },
      },
    });
    expect(input.run.mock.calls.map(([argv]) => argv[5])).toContain(
      "/repos/owner/repo/actions/runs/200/attempts/2/jobs?per_page=50&page=1",
    );
    expect(input.run).toHaveBeenCalledTimes(5);
  });
  it("does not include passing jobs or passing steps of a failing job", async () => {
    const input = request();
    const base = workflowRunner();
    const passing = {
      ...JOB,
      id: 301,
      url: "https://api.github.com/repos/owner/repo/actions/jobs/301",
      name: "Passing job",
      conclusion: "success",
    };
    const failed = {
      ...JOB,
      steps: [
        ...JOB.steps,
        { number: 2, name: "Passing step", status: "completed", conclusion: "success" },
      ],
    };
    input.run.mockImplementation((argv) =>
      argv[5]?.includes("/jobs?") === true
        ? Promise.resolve(response({ total: 2, values: [failed, passing] }))
        : base(argv),
    );
    const result = await readGitCiFailureContext(input);
    expect(JSON.stringify(result)).not.toContain("Passing job");
    expect(JSON.stringify(result)).not.toContain("Passing step");
  });
  it.each([
    { headSha: BASE },
    { runId: 201 },
    { url: "https://evil.test/300" },
    { url: "https://api.github.com/repos/other/repo/actions/jobs/300" },
  ])("refuses jobs with changed source identity %j", async (change) => {
    const input = request();
    const base = workflowRunner();
    input.run.mockImplementation((argv) =>
      argv[5]?.includes("/jobs?") === true
        ? Promise.resolve(response({ total: 1, values: [{ ...JOB, ...change }] }))
        : base(argv),
    );
    expect(await readGitCiFailureContext(input)).toMatchObject({
      status: "unavailable",
      failure: { reason: "revision-changed" },
    });
  });
  it("rejects a newer workflow attempt after the job read", async () => {
    const input = request();
    const base = workflowRunner();
    let sourceReads = 0;
    input.run.mockImplementation((argv) => {
      if (argv[5]?.endsWith("/actions/runs/200") === true && ++sourceReads === 2)
        return Promise.resolve(
          response({
            ...WORKFLOW,
            runAttempt: 3,
            repository: "owner/repo",
            url: "https://api.github.com/repos/owner/repo/actions/runs/200",
          }),
        );
      return base(argv);
    });
    expect(await readGitCiFailureContext(input)).toMatchObject({
      status: "unavailable",
      failure: { reason: "revision-changed" },
    });
  });
  it.each([
    { status: "unexpected" },
    { steps: [{ ...JOB.steps[0], name: {} }] },
    { steps: [{ ...JOB.steps[0], status: 1 }] },
    { steps: [JOB.steps[0], JOB.steps[0]] },
  ])("rejects malformed job metadata %j", async (change) => {
    const input = request();
    const base = workflowRunner();
    input.run.mockImplementation((argv) =>
      argv[5]?.includes("/jobs?") === true
        ? Promise.resolve(response({ total: 1, values: [{ ...JOB, ...change }] }))
        : base(argv),
    );
    expect(await readGitCiFailureContext(input)).toMatchObject({
      status: "unavailable",
      failure: { reason: "malformed-response" },
    });
  });
});

describe("CI diagnostic pagination and content bounds", () => {
  it("refuses more than four required failed sources before reading bodies", async () => {
    const checks = Array.from({ length: 5 }, (_, index) => ({
      ...CHECK,
      id: index + 1,
      name: `required-${String(index)}`,
    }));
    const facts = failureFacts(
      checks,
      checks.map((check) => check.name),
    );
    const run = failureRunner(facts);
    expect(
      await readGitCiFailureContext({ facts, run, stillAuthorized: (): boolean => true }),
    ).toMatchObject({ status: "unavailable", failure: { reason: "pagination-exhausted" } });
    expect(run).not.toHaveBeenCalled();
  });
  it("refuses incomplete annotation pagination after exactly two bounded pages", async () => {
    const facts = failureFacts([{ ...CHECK, annotationCount: 101 }]);
    const base = failureRunner(facts);
    const run = vi.fn((argv: readonly string[]): Promise<CommandResult> => {
      if (!argv[5]?.includes("/annotations?")) return base(argv);
      const offset = argv[5].endsWith("page=2") ? 50 : 0;
      return Promise.resolve(
        response(
          Array.from({ length: 50 }, (_, index) => ({
            ...ANNOTATION,
            startLine: index + offset + 1,
            endLine: index + offset + 1,
          })),
        ),
      );
    });
    expect(
      await readGitCiFailureContext({ facts, run, stillAuthorized: (): boolean => true }),
    ).toMatchObject({ status: "unavailable", failure: { reason: "pagination-exhausted" } });
    expect(run.mock.calls.filter(([argv]) => argv[5]?.includes("/annotations?"))).toHaveLength(2);
  });
  it("marks truncated returned entries and serialized UTF8 bytes explicitly", async () => {
    const facts = failureFacts([{ ...CHECK, annotationCount: 40 }]);
    const base = failureRunner(facts);
    const run = (argv: readonly string[]): Promise<CommandResult> =>
      argv[5]?.includes("/annotations?") === true
        ? Promise.resolve(
            response(
              Array.from({ length: 40 }, (_, index) => ({
                ...ANNOTATION,
                startLine: index + 1,
                endLine: index + 1,
                message: "🔴".repeat(500),
              })),
            ),
          )
        : base(argv);
    const result = await readGitCiFailureContext({
      facts,
      run,
      stillAuthorized: (): boolean => true,
    });
    expect(result).toMatchObject({
      status: "observed",
      context: { completeness: { complete: false, failure: { reason: "output-truncated" } } },
    });
    if (result.status !== "observed") throw new Error("Missing context");
    expect(result.context.entries.length).toBeLessThanOrEqual(32);
    expect(Buffer.byteLength(JSON.stringify(result.context))).toBeLessThanOrEqual(16_384);
    expect(JSON.stringify(result)).not.toContain("�");
  });
  it("returns a bounded empty context for a failed check without supplied diagnostics", async () => {
    const facts = failureFacts([{ ...CHECK, annotationCount: 0 }]);
    const base = failureRunner(facts);
    const run = (argv: readonly string[]): Promise<CommandResult> => {
      if (argv[5]?.includes("/annotations?") === true) return Promise.resolve(response([]));
      if (argv[5]?.endsWith("/check-runs/123") === true)
        return Promise.resolve(
          response({
            ...checkValue({ ...CHECK, annotationCount: 0 }),
            title: null,
            summary: "",
            text: null,
          }),
        );
      return base(argv);
    };
    expect(
      await readGitCiFailureContext({ facts, run, stillAuthorized: (): boolean => true }),
    ).toMatchObject({
      status: "observed",
      context: { entries: [], sourceCount: 1, completeness: { complete: true } },
    });
  });
  it("does not accept an annotation source count mismatch or duplicate page entry", async () => {
    for (const values of [[], [ANNOTATION, ANNOTATION]]) {
      const facts = failureFacts([{ ...CHECK, annotationCount: values.length || 1 }]);
      const base = failureRunner(facts);
      const run = (argv: readonly string[]): Promise<CommandResult> =>
        argv[5]?.includes("/annotations?") === true
          ? Promise.resolve(response(values))
          : base(argv);
      expect(
        await readGitCiFailureContext({ facts, run, stillAuthorized: (): boolean => true }),
      ).toMatchObject({ status: "unavailable" });
    }
  });
});

describe("malformed annotation data", () => {
  it.each([
    { message: null },
    { path: 1 },
    { startLine: 0 },
    { endLine: 1 },
    { level: "unknown" },
    { details: {} },
  ])("refuses malformed fields %j", async (change) => {
    const facts = failureFacts();
    const base = failureRunner();
    const run = (argv: readonly string[]): Promise<CommandResult> =>
      argv[5]?.includes("/annotations?") === true
        ? Promise.resolve(response([{ ...ANNOTATION, ...change }]))
        : base(argv);
    expect(
      await readGitCiFailureContext({ facts, run, stillAuthorized: (): boolean => true }),
    ).toMatchObject({ status: "unavailable", failure: { reason: "malformed-response" } });
  });
});
