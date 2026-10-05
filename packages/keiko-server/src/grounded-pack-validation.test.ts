import { describe, expect, it, vi } from "vitest";
import type { ConnectedContextPack } from "@oscharko-dev/keiko-contracts/connected-context";
import { ContextPackValidationError } from "@oscharko-dev/keiko-workflows";
import { caughtGroundedPackValidation, inspectGroundedPack } from "./grounded-pack-validation.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";

describe("grounded pack validation failure evidence", () => {
  it("preserves the actual validator exception and cause without inventing a violation count", () => {
    const error = new TypeError("private-validator-body", { cause: new Error("private-cause") });
    const pack = Object.defineProperty({}, "schemaVersion", {
      get: () => {
        throw error;
      },
    });
    const record = vi.fn<(record: ServerDiagnosticRecord) => void>();
    const failure = inspectGroundedPack(pack as ConnectedContextPack, {
      deps: { diagnostics: { record }, redactor: (message) => message },
      correlationId: "pack-validator-exception",
      outcome: "source-skipped",
      sourceIndex: 2,
    });
    expect(failure?.error).toBe(error);
    expect(failure).toMatchObject({ validatorThrew: true, validationReasons: ["invalid-shape"] });
    expect(failure).not.toHaveProperty("violationCount");
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "pack-validator-exception",
        diagnosticOutcome: "source-skipped",
        validatorThrew: true,
        sourceIndex: 2,
      }),
    );
  });

  it("retains the actual assembler error and converts every reason to a closed class", () => {
    const error = Object.assign(new ContextPackValidationError(4), {
      validationReasons: [
        "omitted[0].scopePath invalid",
        "pack.omitted contains overlapping scopePath",
        "pack.omitted contains duplicate scopePath",
        "private-error-text",
      ],
    });
    const failure = caughtGroundedPackValidation(error);
    expect(failure?.error).toBe(error);
    expect(failure).toMatchObject({
      violationCount: 4,
      originalCode: "CONTEXT_PACK_OMISSIONS_INVALID",
      validatorThrew: true,
      validationReasons: [
        "omissions-invalid-path",
        "omissions-overlap",
        "omissions-duplicate",
        "other",
      ],
    });
    expect(JSON.stringify(failure?.validationReasons)).not.toContain("private-");
  });

  it("does not classify an unrelated coded error as an assembler failure", () => {
    expect(
      caughtGroundedPackValidation(
        Object.assign(new Error("private-body"), { code: "CONTEXT_PACK_OMISSIONS_INVALID" }),
      ),
    ).toBeUndefined();
  });
});
