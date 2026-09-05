// A HarnessCatalogError raised before the model call settles (captureModelToolCalls rejects a
// tool_calls response with no bound catalog) must classify by its OWN category, exactly like
// runOneTool's catch already does for a tool-execution failure -- never collapse it into the
// generic non-retryable HARNESS_MODEL_ERROR (which would misreport a catalog-binding defect as a
// provider/model fault). Failing before the fix: onModelError forced HARNESS_MODEL_ERROR here.
import { describe, expect, it } from "vitest";
import { handleModelCall } from "./executor.js";
import { HARNESS_CODES } from "./errors.js";
import { buildContext, response, scriptedModel } from "./_support.js";

describe("onModelError HarnessCatalogError classification", () => {
  it("classifies a pre-dispatch catalog-unavailable failure by its own category", async () => {
    const model = scriptedModel([
      response({
        finishReason: "tool_calls",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "a.ts" } }],
      }),
    ]);
    const { ctx } = buildContext({
      task: { taskType: "investigate-bug", input: { description: "d" } },
      model: model.port,
    });
    // No catalog bound for this run -- captureModelToolCalls must fail closed, and that failure
    // must surface under its own HarnessCatalogError category, not a generic model error.
    ctx.catalog = undefined;

    const step = await handleModelCall(ctx);

    expect(step).toEqual({
      to: "failed",
      reason: "catalog dispatch failed before the model call completed",
    });
    expect(ctx.failure?.category).toBe(HARNESS_CODES.TOOL_ERROR);
    expect(ctx.failure?.category).not.toBe(HARNESS_CODES.MODEL_ERROR);
  });
});
