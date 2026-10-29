import { describe, expect, it } from "vitest";
import { observeIndexedMembers } from "./__tests__/support/observed-indexed-members.js";
import {
  knowledgeRejectedTextMembers,
  knowledgeCapturedExtentMembers,
  knowledgeFinalExtentFailureMembers,
} from "./__tests__/support/protocol-observation-mechanics.js";

import { validateKnowledgeCapsule } from "./local-knowledge-validation.js";
import { validateKnowledgePodSummary } from "./local-knowledge-pods.js";
import {
  validateKnowledgeCapsule as publicValidateKnowledgeCapsule,
  type LocalKnowledgeValidation,
} from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-validation";
import { validateKnowledgePodSummary as publicValidateSummary } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-pods";
import { capsuleInput, happySummary } from "./__tests__/support/knowledge-array-fixtures.js";

type KnowledgeTextValidator = (input: unknown) => LocalKnowledgeValidation<unknown>;

interface KnowledgeTextArrayObservationBinding {
  readonly source: KnowledgeTextValidator;
  readonly public: KnowledgeTextValidator;
  readonly inputWithTags: (tags: unknown[]) => object;
  readonly diagnostics: {
    readonly changedExtent: string;
    readonly invalidExtent: string;
    readonly invalidMember: string;
  };
  readonly finalExtentFailure: () => TypeError;
  readonly laterMemberFailure: () => TypeError;
  readonly rejectedFinalExtentRefusal: string;
  readonly sparseFinalExtentRefusal: string;
}

function registerCapturedExtent(binding: KnowledgeTextArrayObservationBinding): void {
  it.each(["source", "public"])("preserves captured extent observations through %s", (surface) => {
    const validate = surface === "source" ? binding.source : binding.public;
    for (const state of ["stable", "growth", "shrink", "invalid"]) {
      const trace: string[] = [];
      const members = knowledgeCapturedExtentMembers(["healthy"], trace, state);
      const input = binding.inputWithTags(members);
      const result = validate(input);
      if (state === "stable") {
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value).toBe(input);
      } else {
        expect(result).toEqual({
          ok: false,
          errors: [
            state !== "invalid"
              ? binding.diagnostics.changedExtent
              : binding.diagnostics.invalidExtent,
          ],
        });
      }
      expect(trace).toEqual(state === "invalid" ? ["length"] : ["length", "0", "length"]);
    }
  });
}

function registerFinalExtentFailure(binding: KnowledgeTextArrayObservationBinding): void {
  it.each(["source", "public"])("propagates final extent getter failure through %s", (surface) => {
    const validate = surface === "source" ? binding.source : binding.public;
    const trace: string[] = [];
    const refusal = binding.finalExtentFailure();
    const members = knowledgeFinalExtentFailureMembers(["healthy"], trace, refusal);
    const input = binding.inputWithTags(members);
    let observed: unknown;
    try {
      validate(input);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(refusal);
    expect(trace).toEqual(["length", "0", "length"]);
  });
}

function registerFirstInvalidMember(binding: KnowledgeTextArrayObservationBinding): void {
  it.each(["source", "public"] as const)(
    "stops at the first invalid text member before later index or final extent through %s",
    (surface) => {
      const validate = surface === "source" ? binding.source : binding.public;
      const trace: string[] = [];
      const values: unknown[] = [7];
      Object.defineProperty(values, "1", {
        get: (): never => {
          throw binding.laterMemberFailure();
        },
      });
      const members = knowledgeRejectedTextMembers(
        values,
        trace,
        binding.rejectedFinalExtentRefusal,
      );
      expect(validate(binding.inputWithTags(members))).toEqual({
        ok: false,
        errors: [binding.diagnostics.invalidMember],
      });
      expect(trace).toEqual(["get:length", "get:0"]);
    },
  );
}

function registerSparseMember(binding: KnowledgeTextArrayObservationBinding): void {
  it.each(["source", "public"] as const)(
    "reads a sparse text member directly and skips final extent after refusal through %s",
    (surface) => {
      const validate = surface === "source" ? binding.source : binding.public;
      const trace: string[] = [];
      const members = knowledgeRejectedTextMembers(
        new Array<unknown>(1),
        trace,
        binding.sparseFinalExtentRefusal,
      );
      expect(validate(binding.inputWithTags(members))).toEqual({
        ok: false,
        errors: [binding.diagnostics.invalidMember],
      });
      expect(trace).toEqual(["get:length", "get:0"]);
    },
  );
}

function registerInheritedMember(binding: KnowledgeTextArrayObservationBinding): void {
  it.each(["source", "public"] as const)(
    "retains inherited text members and the success-only final extent through %s",
    (surface) => {
      const validate = surface === "source" ? binding.source : binding.public;
      const trace: string[] = [];
      const values = new Array<unknown>(1);
      Object.setPrototypeOf(
        values,
        Object.defineProperty([], "0", { get: (): string => "healthy" }),
      );
      const members = observeIndexedMembers(values, trace);
      const input = binding.inputWithTags(members);
      const result = validate(input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(input);
      expect(trace).toEqual(["get:length", "get:0", "get:length"]);
    },
  );
}

function defineKnowledgeTextArrayObservationContract(
  binding: KnowledgeTextArrayObservationBinding,
): void {
  registerCapturedExtent(binding);
  registerFinalExtentFailure(binding);
  registerFirstInvalidMember(binding);
  registerSparseMember(binding);
  registerInheritedMember(binding);
}

describe("Knowledge capsule tag-array observations", () => {
  defineKnowledgeTextArrayObservationContract({
    source: validateKnowledgeCapsule,
    public: publicValidateKnowledgeCapsule,
    inputWithTags: (tags: unknown[]): object => ({ ...capsuleInput(), tags }),
    diagnostics: {
      changedExtent: "capsule.tags must not change length during validation",
      invalidExtent: "capsule.tags must have a valid array length",
      invalidMember: "capsule.tags entry must be a browser-safe non-empty trimmed string",
    },
    finalExtentFailure: (): TypeError => new TypeError("fixture-final-extent"),
    laterMemberFailure: (): TypeError => new TypeError("Later text member must not be inspected"),
    rejectedFinalExtentRefusal: "Rejected text array must not read final extent",
    sparseFinalExtentRefusal: "Sparse text refusal must not read final extent",
  });
});

describe("Knowledge pod summary tag-array observations", () => {
  defineKnowledgeTextArrayObservationContract({
    source: validateKnowledgePodSummary,
    public: publicValidateSummary,
    inputWithTags: (tags: unknown[]): object => ({ ...happySummary(), tags }),
    diagnostics: {
      changedExtent: "summary.tags must not change length during validation",
      invalidExtent: "summary.tags must have a valid array length",
      invalidMember: "summary.tags entries must be evidence-safe strings",
    },
    finalExtentFailure: (): TypeError => new TypeError("fixture-final-extent"),
    laterMemberFailure: (): TypeError => new TypeError("Later text member must not be inspected"),
    rejectedFinalExtentRefusal: "Rejected text array must not read final extent",
    sparseFinalExtentRefusal: "Sparse text refusal must not read final extent",
  });
});
