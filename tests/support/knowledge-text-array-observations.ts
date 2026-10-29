import { expect, it } from "vitest";
import type { LocalKnowledgeValidation } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-validation";
import { observeIndexedMembers } from "../../packages/keiko-contracts/src/__tests__/support/observed-indexed-members.js";
import {
  knowledgeRejectedTextMembers,
  knowledgeCapturedExtentMembers,
  knowledgeFinalExtentFailureMembers,
} from "../../packages/keiko-contracts/src/__tests__/support/protocol-observation-mechanics.js";

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

export function defineKnowledgeTextArrayObservationContract(
  binding: KnowledgeTextArrayObservationBinding,
): void {
  registerCapturedExtent(binding);
  registerFinalExtentFailure(binding);
  registerFirstInvalidMember(binding);
  registerSparseMember(binding);
  registerInheritedMember(binding);
}
