// Surface pin for the public barrel. A future drop or rename of an exported symbol breaks
// this file at compile time and at test time, giving the change a visible review surface.
//
// The `pin<T>(_v?: T): T | undefined` helper from memory issue #160: typing the value once
// via the generic parameter ensures the symbol is actually present in the public type
// universe. The `_v` parameter is optional and unused so the helper can also stand in as
// a runtime no-op for value-level exports.

import { describe, expect, it } from "vitest";

import * as Barrel from "./index.js";
import type {
  BuildCorrectionInput,
  BuildForgetOperationsOptions,
  ConflictPair,
  ConflictReason,
  ConflictResolution,
  ConflictTransitionResult,
  CorrectionEnvelopes,
  ForgetSelector,
  ForgetSelectorKind,
  GovernanceContext,
  GovernanceErrorCode,
  SelectMemoriesForForgetOptions,
  StatusTransition,
  SuppressionOptions,
  SuppressionReason,
  SuppressionResult,
} from "./index.js";
import {
  buildArchiveOperation,
  buildConflictTransitions,
  buildCorrection,
  buildExpirationUpdate,
  buildForgetOperations,
  buildPinOperation,
  buildUnpinOperation,
  detectConflictPair,
  FORGET_SELECTOR_KINDS,
  GovernanceError,
  isMemorySuppressedFromRetrieval,
  KEIKO_MEMORY_GOVERNANCE_VERSION,
  selectMemoriesForForget,
} from "./index.js";

function pin<T>(_value?: T): T | undefined {
  return undefined;
}

describe("public barrel", () => {
  it("exports the version constant", () => {
    expect(KEIKO_MEMORY_GOVERNANCE_VERSION).toBe("0.1.0");
  });

  it("exports every envelope builder as a function", () => {
    expect(typeof buildCorrection).toBe("function");
    expect(typeof buildConflictTransitions).toBe("function");
    expect(typeof detectConflictPair).toBe("function");
    expect(typeof selectMemoriesForForget).toBe("function");
    expect(typeof buildForgetOperations).toBe("function");
    expect(typeof buildExpirationUpdate).toBe("function");
    expect(typeof buildPinOperation).toBe("function");
    expect(typeof buildUnpinOperation).toBe("function");
    expect(typeof buildArchiveOperation).toBe("function");
    expect(typeof isMemorySuppressedFromRetrieval).toBe("function");
  });

  it("exports GovernanceError as a class", () => {
    expect(typeof GovernanceError).toBe("function");
    expect(new GovernanceError("envelope-validation-failed", "test")).toBeInstanceOf(
      GovernanceError,
    );
  });

  it("exports FORGET_SELECTOR_KINDS as a frozen tuple of every selector kind", () => {
    expect(FORGET_SELECTOR_KINDS).toEqual([
      "by-id",
      "by-scope",
      "by-type",
      "by-source-conversation",
      "by-time-window",
    ]);
  });

  it("does not expose any unexpected runtime exports", () => {
    expect(Object.keys(Barrel).sort()).toEqual(
      [
        "FORGET_SELECTOR_KINDS",
        "GovernanceError",
        "KEIKO_MEMORY_GOVERNANCE_VERSION",
        "buildArchiveOperation",
        "buildConflictTransitions",
        "buildCorrection",
        "buildExpirationUpdate",
        "buildForgetOperations",
        "buildPinOperation",
        "buildUnpinOperation",
        "detectConflictPair",
        "isMemorySuppressedFromRetrieval",
        "selectMemoriesForForget",
      ].sort(),
    );
  });

  it("pins the public type surface (compile-time only)", () => {
    pin<BuildCorrectionInput>();
    pin<BuildForgetOperationsOptions>();
    pin<ConflictPair>();
    pin<ConflictReason>();
    pin<ConflictResolution>();
    pin<ConflictTransitionResult>();
    pin<CorrectionEnvelopes>();
    pin<ForgetSelector>();
    pin<ForgetSelectorKind>();
    pin<GovernanceContext>();
    pin<GovernanceErrorCode>();
    pin<SelectMemoriesForForgetOptions>();
    pin<StatusTransition>();
    pin<SuppressionOptions>();
    pin<SuppressionReason>();
    pin<SuppressionResult>();
    expect(true).toBe(true);
  });
});
