import { describe, expect, it } from "vitest";
import type { CodingWorkbenchVerificationPreview } from "@oscharko-dev/keiko-contracts";
import {
  CODING_WORKBENCH_VERIFICATION_PREVIEW_COMMAND_MAX_CHARS,
  CODING_WORKBENCH_VERIFICATION_PREVIEW_MAX_COMMANDS,
  validateCodingWorkbenchRuntimeApprovalReviewChannelPayload,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-approval-review";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import { VerificationRunnerError } from "../editor/verificationRunnerErrors.js";
import type {
  VerificationCommandPreview,
  VerificationPreviewInput,
} from "../editor/verificationRunner.js";
import {
  createVerificationApprovalPreview,
  cutVisibly,
  previewFromSteps,
  verificationPlanDigest,
} from "./verificationApprovalPreview.js";

const RUN_ID = "3f2b8c1e-5d4a-4e6f-9a1b-0c2d3e4f5a6b";
const BEARER = "Bearer abcdefghijklmnop1234567890";
const PASSWORD = "hunter2-very-secret";

interface Fixture {
  readonly port: (
    ...args: Parameters<ReturnType<typeof createVerificationApprovalPreview>>
  ) => CodingWorkbenchVerificationPreview;
  readonly records: ServerDiagnosticRecord[];
  readonly result: ReturnType<typeof createVerificationApprovalPreview>;
  readonly asked: VerificationPreviewInput[];
}

function fixture(plan: VerificationCommandPreview | Error): Fixture {
  const records: ServerDiagnosticRecord[] = [];
  const asked: VerificationPreviewInput[] = [];
  const result = createVerificationApprovalPreview({
    workspaceRoot: "/work/tree",
    runner: {
      previewCommands: (input): VerificationCommandPreview => {
        asked.push(input);
        if (plan instanceof Error) throw plan;
        return plan;
      },
    },
    diagnostics: { record: (record): void => void records.push(record) },
    now: () => new Date("2026-11-27T10:00:00.000Z"),
  });
  const port = (...args: Parameters<typeof result>): CodingWorkbenchVerificationPreview =>
    result(...args).preview;
  return { port, result, records, asked };
}

const steps = (...entries: readonly string[][]): VerificationCommandPreview => ({
  kind: "steps",
  probeFailures: 0,
  steps: entries.map(([command = "", ...args]) => ({ command, args })),
});

function validReview(preview: unknown): boolean {
  return validateCodingWorkbenchRuntimeApprovalReviewChannelPayload({
    session: "active",
    pending: {
      requestId: "permission-1",
      verificationPreview: preview,
      paths: [],
      pathsTruncated: false,
      fileCount: 0,
      addedLines: 0,
      deletedLines: 0,
    },
  }).ok;
}

describe("verification approval preview", () => {
  it("shows the command the verification would run, as the person would type it", () => {
    const { port } = fixture(steps(["mvn", "-B", "test", "-Dtest=My Test"]));
    const preview = port("test", RUN_ID, {});
    expect(preview).toEqual({
      status: "commands",
      commands: ['mvn -B test "-Dtest=My Test"'],
      truncated: false,
    });
    expect(validReview(preview)).toBe(true);
  });

  it("plans with the package folder the ask named", () => {
    const { port, asked } = fixture(steps(["npm", "run", "test"]));
    port("test", RUN_ID, { packageDir: "packages/app" });
    expect(asked).toEqual([
      { projectId: "/work/tree", kinds: ["test"], packageDir: "packages/app" },
    ]);
  });

  it("shows the script body behind npm run, redacted and bounded", () => {
    const { port } = fixture({
      kind: "steps",
      probeFailures: 0,
      steps: [
        {
          command: "npm",
          args: ["run", "test"],
          scriptName: "test",
          scriptBody: `vitest run --token=${PASSWORD} ${"x".repeat(2_000)}`,
        },
      ],
    });
    const preview = port("test", RUN_ID, {});
    if (preview.status !== "commands") throw new TypeError("expected commands");
    const [line] = preview.commands;
    expect(line).toContain('npm run test\n  runs the project\'s own "test" script: vitest run');
    expect(line).not.toContain(PASSWORD);
    expect(line?.length).toBeLessThanOrEqual(
      CODING_WORKBENCH_VERIFICATION_PREVIEW_COMMAND_MAX_CHARS,
    );
    expect(validReview(preview)).toBe(true);
  });

  it("masks credentials: an Authorization header, a --password flag and a -D system property", () => {
    const preview = previewFromSteps([
      { command: "curl", args: ["-H", `Authorization: ${BEARER}`, "https://example.test"] },
      { command: "mvn", args: ["test", `--password=${PASSWORD}`, `-Dapi.token=${PASSWORD}`] },
    ]);
    const text = JSON.stringify(preview);
    expect(text).not.toContain("abcdefghijklmnop1234567890");
    expect(text).not.toContain(PASSWORD);
    expect(text).toContain("--password=[REDACTED]");
  });

  it("cuts a very long command visibly, within the contract bound", () => {
    const preview = previewFromSteps([{ command: "npm", args: ["run", "x".repeat(5_000)] }]);
    if (preview.status !== "commands") throw new TypeError("expected commands");
    const [line] = preview.commands;
    expect(line?.length).toBe(CODING_WORKBENCH_VERIFICATION_PREVIEW_COMMAND_MAX_CHARS);
    expect(line?.endsWith("…")).toBe(true);
    expect(preview.truncated).toBe(true);
    expect(validReview(preview)).toBe(true);
  });

  it("never splits a surrogate pair when it cuts", () => {
    for (const max of [10, 11, 12]) {
      const { text, cut } = cutVisibly("a".repeat(8) + "😀".repeat(10), max);
      expect(cut).toBe(true);
      expect(text.endsWith("…")).toBe(true);
      expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
      expect(text.length).toBeLessThanOrEqual(max);
    }
  });

  it("caps the number of lines and says the list is cut", () => {
    const many = Array.from(
      { length: CODING_WORKBENCH_VERIFICATION_PREVIEW_MAX_COMMANDS + 3 },
      (_, index) => ["npm", "run", `s${String(index)}`],
    );
    const preview = previewFromSteps(many.map(([command = "", ...args]) => ({ command, args })));
    if (preview.status !== "commands") throw new TypeError("expected commands");
    expect(preview.commands).toHaveLength(CODING_WORKBENCH_VERIFICATION_PREVIEW_MAX_COMMANDS);
    expect(preview.truncated).toBe(true);
  });

  it("names no command for a targeted test, an unresolved package or a Maven project, and says why", () => {
    expect(fixture(steps()).port("targeted-test", RUN_ID, {})).toEqual({
      status: "deferred",
      reason: "targeted-test",
    });
    expect(
      fixture({ kind: "package-selection-required", probeFailures: 0 }).port("test", RUN_ID, {}),
    ).toEqual({ status: "deferred", reason: "package-selection" });
    expect(fixture({ kind: "host-dependent", probeFailures: 0 }).port("test", RUN_ID, {})).toEqual({
      status: "deferred",
      reason: "host-setup",
    });
    expect(validReview({ status: "commands", commands: [], truncated: false })).toBe(false);
  });

  it.each([
    [{ kind: "unresolved", probeFailures: 0 } as const, "workspace-unresolved"],
    [{ kind: "steps", steps: [], probeFailures: 0 } as const, "no-runnable-step"],
    [new VerificationRunnerError("PROJECT_NOT_FOUND", "gone /secret/path"), "workspace-unresolved"],
    [new Error(`boom ${BEARER} at /secret/path`), "preview-failed"],
  ])(
    "falls back to the class label with a closed reason and a body-free log line",
    (plan, reason) => {
      const { port, records } = fixture(plan);
      expect(port("test", RUN_ID, {})).toEqual({ status: "unavailable", reason });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        correlationId: RUN_ID,
        operation: "coding-runtime.approval",
        errorClass: reason,
        message: "approval-preview-unavailable",
      });
      const logged = JSON.stringify(records);
      expect(logged).not.toContain("abcdefghijklmnop1234567890");
      expect(logged).not.toContain("/secret/path");
    },
  );

  it("logs a count of package folders the planning could not read, and nothing else", () => {
    const { port, records } = fixture({
      kind: "steps",
      probeFailures: 2,
      steps: [{ command: "npm", args: ["run", "test"] }],
    });
    port("test", RUN_ID, {});
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ errorClass: "package-probe-failed", code: "failures=2" });
  });

  it("writes no log line when a command is shown, and never a command in any log", () => {
    const { port, records } = fixture(steps(["mvn", "test"]));
    port("test", RUN_ID, {});
    expect(records).toEqual([]);
  });

  describe("binds the approval to the plan it showed (ADR-0124 D6)", () => {
    it("returns the digest of the planned steps with the shown commands", () => {
      const planned = steps(["npm", "run", "test"]);
      const { result } = fixture(planned);
      expect(result("test", RUN_ID, { actionId: "session:call-1" }).planDigest).toBe(
        verificationPlanDigest(planned.kind === "steps" ? planned.steps : []),
      );
    });

    it("returns no digest when no command is shown", () => {
      const { result } = fixture({ kind: "host-dependent", probeFailures: 0 });
      expect(result("test", RUN_ID, {}).planDigest).toBeUndefined();
    });

    it("digests command, arguments, folder and script body, so a rewritten script changes it", () => {
      const base = { command: "npm", args: ["run", "test"], scriptName: "test" };
      const digest = (scriptBody: string, cwd?: string): string =>
        verificationPlanDigest([{ ...base, scriptBody, ...(cwd === undefined ? {} : { cwd }) }]);
      expect(digest("vitest run")).toBe(digest("vitest run"));
      expect(digest("vitest run")).not.toBe(digest("rm -rf / && vitest run"));
      expect(digest("vitest run")).not.toBe(digest("vitest run", "packages/a"));
    });
  });
});
