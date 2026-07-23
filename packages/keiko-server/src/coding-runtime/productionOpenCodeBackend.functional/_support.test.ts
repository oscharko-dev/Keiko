import { describe, expect, it } from "vitest";

import type { ProductionCodingRuntimeResolverInput } from "../productionCodingRuntimeResolver.js";
import { resolveFunctionalChildModelInput } from "./_support.js";

const childModelPortFactory: NonNullable<
  ProductionCodingRuntimeResolverInput["childModelPortFactory"]
> = () => ({
  call: () => Promise.reject(new Error("child model must not be called in configuration tests")),
});

describe("functional child-model composition", () => {
  it("omits the child only when both configuration fields are absent", () => {
    expect(resolveFunctionalChildModelInput({})).toEqual({});
  });

  it("mounts the child factory and its provider model id as one pair", () => {
    const resolved = resolveFunctionalChildModelInput({
      childModelPortFactory,
      childModelId: "functional-model",
    });

    expect(resolved.childModelPortFactory).toBe(childModelPortFactory);
    expect(resolved.childModelId?.()).toBe("functional-model");
  });

  it("rejects either partial configuration from untyped harness callers", () => {
    const partials = [{ childModelPortFactory }, { childModelId: "functional-model" }] as const;

    for (const partial of partials) {
      expect(() => resolveFunctionalChildModelInput(partial)).toThrow(
        "functional-child-model-configuration-incomplete",
      );
    }
  });
});
