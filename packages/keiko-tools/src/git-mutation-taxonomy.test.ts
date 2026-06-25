import { describe, expect, it } from "vitest";
import {
  GIT_DELIVERY_EXECUTION_ERROR_CODES,
  GIT_DELIVERY_SCHEMA_VERSION,
  type GitDeliveryExecutionErrorCode,
  type GitDeliveryExecutionResult,
} from "@oscharko-dev/keiko-contracts";
import {
  GIT_MUTATION_FAILURE_CATEGORIES,
  GIT_MUTATION_LIFECYCLE_PHASES,
  GIT_MUTATION_PHASE_ORDER,
  GIT_MUTATION_STATUSES,
  gitMutationCategoryForExecutionError,
  gitMutationCategoryForExecutionResult,
  gitMutationFailureIsRecoverable,
  isGitMutationFailureCategory,
  isGitMutationLifecyclePhase,
  isGitMutationStatus,
} from "./git-mutation-taxonomy.js";

function result(
  outcome: GitDeliveryExecutionResult["outcome"],
  errorCode?: GitDeliveryExecutionErrorCode,
): GitDeliveryExecutionResult {
  return {
    schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
    outcome,
    durationMs: 1,
    ...(errorCode !== undefined ? { errorCode } : {}),
  };
}

describe("git mutation taxonomy — lifecycle phases", () => {
  it("orders every phase exactly once and consistently with the ordinal table", () => {
    expect(GIT_MUTATION_LIFECYCLE_PHASES).toEqual([
      "resolve",
      "preflight",
      "preview",
      "policy",
      "execute",
      "result",
    ]);
    GIT_MUTATION_LIFECYCLE_PHASES.forEach((phase, index) => {
      expect(GIT_MUTATION_PHASE_ORDER[phase]).toBe(index);
    });
  });

  it("recognizes valid phases and rejects unknown strings", () => {
    expect(isGitMutationLifecyclePhase("execute")).toBe(true);
    expect(isGitMutationLifecyclePhase("commit")).toBe(false);
    expect(isGitMutationLifecyclePhase(3)).toBe(false);
  });
});

describe("git mutation taxonomy — failure categories", () => {
  it("enumerates exactly the five categories Issue #472 names", () => {
    expect([...GIT_MUTATION_FAILURE_CATEGORIES].sort()).toEqual(
      [
        "execution-failure",
        "policy-block",
        "preflight-block",
        "provider-failure",
        "recovery-required",
      ].sort(),
    );
  });

  it("classifies every contract execution error code without a string heuristic", () => {
    // Every code in the closed contract union maps to a category — proves the table is total and a
    // new code would fail the build rather than fall through to an untyped default.
    for (const code of GIT_DELIVERY_EXECUTION_ERROR_CODES) {
      expect(isGitMutationFailureCategory(gitMutationCategoryForExecutionError(code))).toBe(true);
    }
  });

  it("maps each error code to its documented category", () => {
    expect(gitMutationCategoryForExecutionError("provider-rejected")).toBe("provider-failure");
    expect(gitMutationCategoryForExecutionError("network-failure")).toBe("provider-failure");
    expect(gitMutationCategoryForExecutionError("conflict")).toBe("recovery-required");
    expect(gitMutationCategoryForExecutionError("precondition-failed")).toBe("recovery-required");
    expect(gitMutationCategoryForExecutionError("timeout")).toBe("execution-failure");
    expect(gitMutationCategoryForExecutionError("internal-error")).toBe("execution-failure");
  });

  it("only recovery-required routes into the guided recovery workflow", () => {
    expect(gitMutationFailureIsRecoverable("recovery-required")).toBe(true);
    for (const category of GIT_MUTATION_FAILURE_CATEGORIES.filter(
      (c) => c !== "recovery-required",
    )) {
      expect(gitMutationFailureIsRecoverable(category)).toBe(false);
    }
  });
});

describe("git mutation taxonomy — execution result classification", () => {
  it("returns undefined for a clean success", () => {
    expect(gitMutationCategoryForExecutionResult(result("succeeded"))).toBeUndefined();
  });

  it("classifies a failed result by its error code", () => {
    expect(gitMutationCategoryForExecutionResult(result("failed", "conflict"))).toBe(
      "recovery-required",
    );
    expect(gitMutationCategoryForExecutionResult(result("partial", "precondition-failed"))).toBe(
      "recovery-required",
    );
    expect(gitMutationCategoryForExecutionResult(result("failed", "provider-rejected"))).toBe(
      "provider-failure",
    );
  });

  it("classifies a failed result with no code conservatively as execution-failure", () => {
    expect(gitMutationCategoryForExecutionResult(result("failed"))).toBe("execution-failure");
  });

  it("treats an aborted result with no code as a non-failure", () => {
    expect(gitMutationCategoryForExecutionResult(result("aborted"))).toBeUndefined();
  });
});

describe("git mutation taxonomy — status guard", () => {
  it("enumerates the five lifecycle statuses", () => {
    expect([...GIT_MUTATION_STATUSES].sort()).toEqual(
      ["approval-required", "blocked", "failed", "recovery-required", "succeeded"].sort(),
    );
  });

  it("recognizes statuses and rejects unknown strings", () => {
    expect(isGitMutationStatus("succeeded")).toBe(true);
    expect(isGitMutationStatus("done")).toBe(false);
  });
});
