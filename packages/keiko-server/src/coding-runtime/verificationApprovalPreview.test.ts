import { describe, expect, it } from "vitest";
import {
  CODING_WORKBENCH_VERIFICATION_PREVIEW_COMMAND_MAX_CHARS,
  CODING_WORKBENCH_VERIFICATION_PREVIEW_MAX_COMMANDS,
  validateCodingWorkbenchRuntimeApprovalReviewChannelPayload,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-approval-review";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import { VerificationRunnerError } from "../editor/verificationRunnerErrors.js";
import type { VerificationCommandPreview } from "../editor/verificationRunner.js";
import {
  createVerificationApprovalPreview,
  previewFromSteps,
} from "./verificationApprovalPreview.js";

const RUN_ID = "3f2b8c1e-5d4a-4e6f-9a1b-0c2d3e4f5a6b";
const BEARER = "Bearer abcdefghijklmnop1234567890";
const PASSWORD = "hunter2-very-secret";

function port(
  plan: VerificationCommandPreview | Error,
  records: ServerDiagnosticRecord[] = [],
): ReturnType<typeof createVerificationApprovalPreview> {
  return createVerificationApprovalPreview({
    workspaceRoot: "/work/tree",
    runner: {
      previewCommands: (): VerificationCommandPreview => {
        if (plan instanceof Error) throw plan;
        return plan;
      },
    },
    diagnostics: { record: (record): void => void records.push(record) },
    now: () => new Date("2026-11-27T10:00:00.000Z"),
  });
}

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
    const preview = port({
      kind: "steps",
      steps: [{ command: "mvn", args: ["-B", "test", "-Dtest=My Test"] }],
    })("test", RUN_ID);
    expect(preview).toEqual({
      status: "commands",
      commands: ['mvn -B test "-Dtest=My Test"'],
      truncated: false,
    });
    expect(validReview(preview)).toBe(true);
  });

  it("masks credentials with the existing redactors: an Authorization header and a --password flag", () => {
    const preview = previewFromSteps([
      { command: "curl", args: ["-H", `Authorization: ${BEARER}`, "https://example.test"] },
      { command: "mvn", args: ["test", `--password=${PASSWORD}`] },
    ]);
    const text = JSON.stringify(preview);
    expect(text).not.toContain("abcdefghijklmnop1234567890");
    expect(text).not.toContain(PASSWORD);
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("mvn test --password=");
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

  it("caps the number of lines and says the list is cut", () => {
    const steps = Array.from(
      { length: CODING_WORKBENCH_VERIFICATION_PREVIEW_MAX_COMMANDS + 3 },
      (_, index) => ({ command: "npm", args: ["run", `s${String(index)}`] }),
    );
    const preview = previewFromSteps(steps);
    if (preview.status !== "commands") throw new TypeError("expected commands");
    expect(preview.commands).toHaveLength(CODING_WORKBENCH_VERIFICATION_PREVIEW_MAX_COMMANDS);
    expect(preview.truncated).toBe(true);
  });

  it("names no command for a targeted test or an unresolved package, with a reason, never empty", () => {
    expect(port({ kind: "steps", steps: [] })("targeted-test", RUN_ID)).toEqual({
      status: "deferred",
      reason: "targeted-test",
    });
    expect(port({ kind: "package-selection-required" })("test", RUN_ID)).toEqual({
      status: "deferred",
      reason: "package-selection",
    });
    expect(validReview({ status: "commands", commands: [], truncated: false })).toBe(false);
  });

  it.each([
    [{ kind: "unresolved" } as const, "workspace-unresolved"],
    [new VerificationRunnerError("PROJECT_NOT_FOUND", "gone /secret/path"), "workspace-unresolved"],
    [{ kind: "steps", steps: [] } as const, "no-runnable-step"],
    [new Error(`boom ${BEARER} at /secret/path`), "preview-failed"],
  ])(
    "falls back to the class label with a closed reason and a body-free log line",
    (plan, reason) => {
      const records: ServerDiagnosticRecord[] = [];
      const preview = port(plan, records)("test", RUN_ID);
      expect(preview).toEqual({ status: "unavailable", reason });
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

  it("writes no log line when a command is shown, and never a command in any log", () => {
    const records: ServerDiagnosticRecord[] = [];
    port({ kind: "steps", steps: [{ command: "mvn", args: ["test"] }] }, records)("test", RUN_ID);
    expect(records).toEqual([]);
  });
});
