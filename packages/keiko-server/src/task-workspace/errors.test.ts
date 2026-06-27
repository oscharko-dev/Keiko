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
import {
  classifyTaskWorkspaceError,
  TaskWorkspaceError,
  type TaskWorkspaceErrorCode,
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
