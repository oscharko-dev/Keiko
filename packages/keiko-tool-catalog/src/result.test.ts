import { describe, expect, it } from "vitest";
import {
  TOOL_RESULT_REASONS,
  TOOL_PAGE_REASONS,
  type ToolResultEnvelope,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  createToolDescriptor,
  validateToolResultEnvelope,
  type ToolResultValidationBinding,
} from "./index.js";
import { catalogBytes } from "./json.js";
import { declaration, fixture } from "./__fixtures__/catalog.js";

function completed(): {
  readonly binding: ToolResultValidationBinding;
  readonly result: Extract<ToolResultEnvelope, { status: "completed" }>;
} {
  const { descriptor, projection } = fixture();
  const data = { text: "safe" };
  return {
    binding: { descriptor, projectionDigest: projection.projectionDigest },
    result: {
      schemaVersion: 1,
      invocationId: "invocation-1",
      toolRef: descriptor.toolRef,
      projectionDigest: projection.projectionDigest,
      status: "completed",
      reason: "none",
      effectStarted: true,
      metrics: { inputBytes: 0, outputBytes: catalogBytes(data), resultCount: 1, durationMs: 0 },
      page: { truncated: false, reason: "none", cursor: null },
      data,
    },
  };
}
const terminalCases = Object.entries(TOOL_RESULT_REASONS).flatMap(([status, reasons]) =>
  reasons.map((reason) => [status, reason] as const),
);
describe("bounded terminal envelope qualification", () => {
  it.each(terminalCases)(
    "represents %s/%s without inventing settlement decisions",
    (status, reason) => {
      const { binding, result } = completed();
      const value = {
        ...result,
        status,
        reason,
        ...(status === "completed"
          ? {}
          : {
              page: null,
              data: null,
              metrics: { ...result.metrics, outputBytes: 0, resultCount: 0 },
            }),
      };
      const parsed = validateToolResultEnvelope(value, binding);
      expect(parsed).toEqual(value);
      expect(Object.isFrozen(parsed.metrics)).toBe(true);
      expect(() =>
        validateToolResultEnvelope({ ...value, reason: "arbitrary-private-text" }, binding),
      ).toThrow("result-contract-failed");
    },
  );
  it.each(TOOL_PAGE_REASONS)("represents completed page reason %s", (reason) => {
    const { binding, result } = completed();
    const page = {
      truncated: reason !== "none",
      reason,
      cursor: reason === "none" ? null : "opaque-cursor-1",
    };
    expect(validateToolResultEnvelope({ ...result, page }, binding).page).toEqual(page);
  });
  it.each([
    { status: "unknown" },
    { schemaVersion: 2 },
    { invocationId: "customer/private" },
    { invocationId: "x".repeat(129) },
    { toolRef: null },
    { projectionDigest: "invalid" },
    { effectStarted: "yes" },
    { page: null },
    { data: null },
    { page: { truncated: true, reason: "none", cursor: null } },
    { page: { truncated: true, reason: "result-cap", cursor: "x".repeat(4097) } },
    { page: { truncated: true, reason: "result-cap", cursor: "private/body" } },
    { page: { truncated: true, reason: "result-cap", cursor: "" } },
    { extra: "private-body" },
    { data: { text: "safe", secret: "private-body" } },
  ])("rejects invalid identities and contradictory or oversized pages %j", (change) => {
    const { binding, result } = completed();
    expect(() => validateToolResultEnvelope({ ...result, ...change }, binding)).toThrow(
      "result-contract-failed",
    );
  });
  it.each([
    { inputBytes: 1025 },
    { outputBytes: 2049 },
    { outputBytes: 0 },
    { resultCount: 2 },
    { durationMs: -1 },
    { durationMs: 0.5 },
    { inputBytes: NaN },
    { secret: "private" },
  ])("rejects dishonest or unbounded metrics %j", (change) => {
    const { binding, result } = completed();
    expect(() =>
      validateToolResultEnvelope({ ...result, metrics: { ...result.metrics, ...change } }, binding),
    ).toThrow("result-contract-failed");
  });
  it("requires a current descriptor for completed data and bounds the entire envelope", () => {
    const { binding, result } = completed();
    expect(() => validateToolResultEnvelope(result)).toThrow("result-contract-failed");
    expect(() =>
      validateToolResultEnvelope(result, {
        ...binding,
        descriptor: { ...binding.descriptor, description: "tampered" },
      }),
    ).toThrow("result-contract-failed");
    const descriptor = createToolDescriptor({
      ...declaration(),
      bounds: { ...binding.descriptor.bounds, maxResultBytes: 100 },
    });
    expect(() => validateToolResultEnvelope(result, { ...binding, descriptor })).toThrow(
      "result-contract-failed",
    );
    const other = createToolDescriptor(declaration(2));
    expect(() => validateToolResultEnvelope(result, { ...binding, descriptor: other })).toThrow(
      "result-contract-failed",
    );
  });
});
