// Surface pin for the public barrel. A future drop or rename of an exported symbol breaks
// this file at compile time and at test time, giving the change a visible review surface.
//
// The `pin<T>(_v?: T): T | undefined` helper from memory issue #160: typing the value once via
// the generic parameter ensures the symbol is actually present in the public type universe.
// The `_v` parameter is optional and unused so the helper can also stand in as a runtime
// no-op for value-level exports.

import { describe, expect, it } from "vitest";

import * as Barrel from "./index.js";
import type {
  ConsolidationJob,
  ConsolidationJobState,
  ConsolidationOptions,
  ConsolidationResult,
  ProposedAction,
  ReviewItem,
  ReviewReason,
  StaleFlag,
  StaleReason,
} from "./index.js";
import {
  buildConsolidationJob,
  ConsolidationJobError,
  KEIKO_MEMORY_CONSOLIDATION_VERSION,
  runConsolidation,
  transitionJob,
  type ConsolidationJobErrorCode,
} from "./index.js";

function pin<T>(_value?: T): T | undefined {
  return undefined;
}

describe("public barrel", () => {
  it("exports the version constant", () => {
    expect(KEIKO_MEMORY_CONSOLIDATION_VERSION).toBe("0.1.0");
  });

  it("exports runConsolidation as a function", () => {
    expect(typeof runConsolidation).toBe("function");
  });

  it("exports buildConsolidationJob as a function", () => {
    expect(typeof buildConsolidationJob).toBe("function");
  });

  it("exports transitionJob as a function", () => {
    expect(typeof transitionJob).toBe("function");
  });

  it("exports ConsolidationJobError as a class", () => {
    expect(typeof ConsolidationJobError).toBe("function");
    expect(new ConsolidationJobError("invalid-transition", "queued", "completed")).toBeInstanceOf(
      ConsolidationJobError,
    );
  });

  it("does not expose any unexpected runtime exports", () => {
    // Pin the full set of runtime (non-type) exports. Adding a runtime export requires
    // updating this list, which puts the change in the review diff.
    expect(Object.keys(Barrel).sort()).toEqual(
      [
        "ConsolidationJobError",
        "KEIKO_MEMORY_CONSOLIDATION_VERSION",
        "buildConsolidationJob",
        "runConsolidation",
        "transitionJob",
      ].sort(),
    );
  });

  it("pins the public type surface (compile-time only)", () => {
    pin<ConsolidationJob>();
    pin<ConsolidationJobState>();
    pin<ConsolidationOptions>();
    pin<ConsolidationResult>();
    pin<ProposedAction>();
    pin<ReviewItem>();
    pin<ReviewReason>();
    pin<StaleFlag>();
    pin<StaleReason>();
    pin<ConsolidationJobErrorCode>();
    expect(true).toBe(true);
  });
});
