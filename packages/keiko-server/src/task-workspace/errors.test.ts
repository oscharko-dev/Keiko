// Unit coverage for the caller-facing failure taxonomy (Issue #449, ADR-0093 D3). Every
// `TaskWorkspaceErrorCode` must map to exactly one of the five `WorkspaceFailureClass`es so a BFF/UI
// caller can branch on a stable signal (retryable / repairable / blocked / policy-denied / terminal)
// instead of the raw code list. The map is total by construction; this proves the concrete assignment
// and the derived `failureClass` getter, and asserts the contract vocabulary stays in lock-step.

import { describe, expect, it } from "vitest";
import {
  isWorkspaceFailureClass,
  WORKSPACE_FAILURE_CLASSES,
  type WorkspaceFailureClass,
} from "@oscharko-dev/keiko-contracts";
import { CodedHttpError } from "@oscharko-dev/keiko-contracts";
import {
  classifyTaskWorkspaceError,
  TaskWorkspaceError,
  taskWorkspaceErrorOutcome,
  type TaskWorkspaceErrorCode,
  type WorkspaceFailureOutcome,
} from "./errors.js";

const EXPECTED: Readonly<Record<TaskWorkspaceErrorCode, WorkspaceFailureClass>> = {
  INVALID_REQUEST: "blocked",
  MISSING_REPOSITORY: "blocked",
  INVALID_BASE_BRANCH: "blocked",
  UNSAFE_PATH: "blocked",
  BRANCH_CONFLICT: "blocked",
  EXISTING_UNMANAGED_PATH: "blocked",
  LOCK_CONTENTION: "retryable",
  POINTER_DRIFT: "repairable",
  PROVISIONING_FAILED: "terminal",
  WORKSPACE_NOT_FOUND: "blocked",
  ILLEGAL_TRANSITION: "blocked",
  OPERATOR_APPROVAL_REQUIRED: "policy-denied",
  REPAIR_NOT_APPLICABLE: "blocked",
  REPAIR_FAILED: "terminal",
  CLEANUP_NOT_ELIGIBLE: "blocked",
  CLEANUP_FAILED: "terminal",
};

describe("classifyTaskWorkspaceError", () => {
  it("maps every error code to its documented failure class", () => {
    for (const [code, expected] of Object.entries(EXPECTED) as [
      TaskWorkspaceErrorCode,
      WorkspaceFailureClass,
    ][]) {
      expect(classifyTaskWorkspaceError(code)).toBe(expected);
    }
  });

  it("only ever returns a valid contract failure class", () => {
    for (const code of Object.keys(EXPECTED) as TaskWorkspaceErrorCode[]) {
      expect(isWorkspaceFailureClass(classifyTaskWorkspaceError(code))).toBe(true);
    }
  });

  it("exercises all five failure classes across the code space (no class is dead)", () => {
    const produced = new Set(
      (Object.keys(EXPECTED) as TaskWorkspaceErrorCode[]).map(classifyTaskWorkspaceError),
    );
    expect(produced).toEqual(new Set(WORKSPACE_FAILURE_CLASSES));
  });

  it("distinguishes retry from repair — the two retry-required codes get different caller actions", () => {
    // Both LOCK_CONTENTION and POINTER_DRIFT record evidence outcome `retry-required`, but the caller
    // action differs: plain retry vs. route to #447 repair. The taxonomy must keep them apart.
    expect(classifyTaskWorkspaceError("LOCK_CONTENTION")).toBe("retryable");
    expect(classifyTaskWorkspaceError("POINTER_DRIFT")).toBe("repairable");
  });
});

// GEN-DUP-NEAR-008 — TaskWorkspaceError now derives its HTTP status through the shared
// CodedHttpError mechanism. The status + outcome half of the taxonomy must be UNCHANGED by that
// refactor: same status per code, same evidence outcome, and the class still instanceof Error /
// CodedHttpError with the concrete subclass name.
const EXPECTED_STATUS: Readonly<Record<TaskWorkspaceErrorCode, number>> = {
  INVALID_REQUEST: 400,
  MISSING_REPOSITORY: 400,
  INVALID_BASE_BRANCH: 400,
  UNSAFE_PATH: 400,
  BRANCH_CONFLICT: 409,
  EXISTING_UNMANAGED_PATH: 409,
  LOCK_CONTENTION: 409,
  POINTER_DRIFT: 409,
  PROVISIONING_FAILED: 500,
  WORKSPACE_NOT_FOUND: 404,
  ILLEGAL_TRANSITION: 409,
  OPERATOR_APPROVAL_REQUIRED: 403,
  REPAIR_NOT_APPLICABLE: 409,
  REPAIR_FAILED: 500,
  CLEANUP_NOT_ELIGIBLE: 409,
  CLEANUP_FAILED: 500,
};

const EXPECTED_OUTCOME: Readonly<Record<TaskWorkspaceErrorCode, WorkspaceFailureOutcome>> = {
  INVALID_REQUEST: "blocked",
  MISSING_REPOSITORY: "blocked",
  INVALID_BASE_BRANCH: "blocked",
  UNSAFE_PATH: "blocked",
  BRANCH_CONFLICT: "blocked",
  EXISTING_UNMANAGED_PATH: "blocked",
  LOCK_CONTENTION: "retry-required",
  POINTER_DRIFT: "retry-required",
  PROVISIONING_FAILED: "failed",
  WORKSPACE_NOT_FOUND: "blocked",
  ILLEGAL_TRANSITION: "blocked",
  OPERATOR_APPROVAL_REQUIRED: "blocked",
  REPAIR_NOT_APPLICABLE: "blocked",
  REPAIR_FAILED: "failed",
  CLEANUP_NOT_ELIGIBLE: "blocked",
  CLEANUP_FAILED: "failed",
};

describe("TaskWorkspaceError status + outcome (GEN-DUP-NEAR-008)", () => {
  it("derives the documented HTTP status per code via the shared mechanism", () => {
    for (const [code, status] of Object.entries(EXPECTED_STATUS) as [
      TaskWorkspaceErrorCode,
      number,
    ][]) {
      expect(new TaskWorkspaceError(code, "m").status).toBe(status);
    }
  });

  it("keeps LOCK_CONTENTION at 409 with retry-required outcome and retryable class", () => {
    const err = new TaskWorkspaceError("LOCK_CONTENTION", "locked");
    expect(err.status).toBe(409);
    expect(err.outcome).toBe("retry-required");
    expect(err.failureClass).toBe("retryable");
  });

  it("keeps the evidence outcome per code unchanged", () => {
    for (const [code, outcome] of Object.entries(EXPECTED_OUTCOME) as [
      TaskWorkspaceErrorCode,
      WorkspaceFailureOutcome,
    ][]) {
      expect(new TaskWorkspaceError(code, "m").outcome).toBe(outcome);
      expect(taskWorkspaceErrorOutcome(code)).toBe(outcome);
    }
  });

  it("is an instanceof Error and CodedHttpError with the concrete subclass name", () => {
    const err = new TaskWorkspaceError("PROVISIONING_FAILED", "boom");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CodedHttpError);
    expect(err.name).toBe("TaskWorkspaceError");
  });

  it("carries the reasons array through unchanged", () => {
    const err = new TaskWorkspaceError("UNSAFE_PATH", "no", ["a", "b"]);
    expect(err.reasons).toEqual(["a", "b"]);
  });
});

describe("TaskWorkspaceError.failureClass", () => {
  it("derives the class from the code without storing it", () => {
    const err = new TaskWorkspaceError("LOCK_CONTENTION", "locked");
    expect(err.failureClass).toBe("retryable");
    const denied = new TaskWorkspaceError("OPERATOR_APPROVAL_REQUIRED", "needs approval");
    expect(denied.failureClass).toBe("policy-denied");
    const terminal = new TaskWorkspaceError("CLEANUP_FAILED", "removal errored");
    expect(terminal.failureClass).toBe("terminal");
  });

  it("keeps failureClass consistent with classifyTaskWorkspaceError for every code", () => {
    for (const code of Object.keys(EXPECTED) as TaskWorkspaceErrorCode[]) {
      expect(new TaskWorkspaceError(code, "m").failureClass).toBe(classifyTaskWorkspaceError(code));
    }
  });
});
