import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  captureToolInvocationReceipt,
  TOOL_HANDLER_READINESS,
  TOOL_LIFECYCLE_OPERATIONS,
  toolLifecyclePhaseFor,
} from "./governed-tool-lifecycle.js";

describe("governed tool lifecycle wire vocabulary", () => {
  it("captures only the exact bounded scalar receipt without argument or result storage", () => {
    const receipt = {
      invocationId: "invocation-1",
      reservationId: null,
      settlementId: "settlement-1",
      budgetDisposition: "not-reserved",
      effectStarted: false,
      status: "denied",
    };
    const parsed = captureToolInvocationReceipt(receipt);
    expect(parsed).toEqual(receipt);
    expect(parsed).not.toBe(receipt);
    expect(Object.isFrozen(parsed)).toBe(true);
    for (const patch of [
      { arguments: "private-body" },
      { result: "private-body" },
      { status: "eighth" },
      { invocationId: "x".repeat(129) },
      { reservationId: "reserved" },
      { effectStarted: true },
      { budgetDisposition: "unknown" },
    ])
      expect(() => captureToolInvocationReceipt({ ...receipt, ...patch })).toThrow(
        "Invalid tool invocation receipt",
      );
    let reads = 0;
    const getter = Object.defineProperty({ ...receipt }, "status", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "denied";
      },
    });
    expect(() => captureToolInvocationReceipt(getter)).toThrow("Invalid tool invocation receipt");
    expect(reads).toBe(0);
  });
  it("matches each generated #3412 producer declaration exactly", () => {
    const generated = JSON.parse(
      readFileSync(
        new URL("../../../docs/observability/tool-catalog-operations.v1.json", import.meta.url),
        "utf8",
      ),
    ) as {
      contracts: readonly { phase: string; op: string }[];
      readinessVocabulary: readonly string[];
    };
    expect(Object.entries(TOOL_LIFECYCLE_OPERATIONS)).toEqual(
      generated.contracts.map((entry) => [entry.phase, entry.op]),
    );
    expect(TOOL_HANDLER_READINESS).toEqual(generated.readinessVocabulary);
    for (const declaration of generated.contracts)
      expect(toolLifecyclePhaseFor(declaration.op)).toBe(declaration.phase);
    expect(toolLifecyclePhaseFor("tool-catalog.unknown")).toBeUndefined();
  });
  it("keeps runtime vocabulary immutable", () => {
    expect(Object.isFrozen(TOOL_LIFECYCLE_OPERATIONS)).toBe(true);
    expect(Object.isFrozen(TOOL_HANDLER_READINESS)).toBe(true);
  });
  it.each(["commit-uncertain", "release-uncertain"] as const)(
    "captures only consistent failed accounting uncertainty: %s",
    (budgetDisposition) => {
      const receipt = {
        invocationId: "invocation-1",
        settlementId: "settlement-1",
        reservationId: "reservation-1",
        status: "failed",
        budgetDisposition,
        effectStarted: budgetDisposition === "commit-uncertain",
      };
      expect(captureToolInvocationReceipt(receipt)).toEqual(receipt);
      for (const patch of [
        { status: "completed" },
        { reservationId: null },
        { effectStarted: !receipt.effectStarted },
      ])
        expect(() => captureToolInvocationReceipt({ ...receipt, ...patch })).toThrow();
    },
  );
});
