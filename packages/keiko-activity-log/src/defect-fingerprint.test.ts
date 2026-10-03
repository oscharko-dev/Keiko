import { describe, expect, it } from "vitest";
import { ACTIVITY_LOG_UNKNOWN_CORRELATION_ID } from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  computeDefectFingerprint,
  registeredFailureFingerprintInput,
  registeredFailureCorrelation,
} from "./defect-fingerprint.js";

const frame = (digest: string, line = 1): string =>
  `dist/ui/static/_next/static/chunks/sha256-${digest.repeat(64)}.js:${String(line)}:1`;
const fingerprint = (facts: Parameters<typeof registeredFailureFingerprintInput>[0]): string =>
  computeDefectFingerprint(registeredFailureFingerprintInput(facts));

describe("registered browser defect identity", () => {
  it("distinguishes closed context and genuine product chunk shapes", () => {
    const base = { op: "client.diagnostic", errorKind: "internal", clientKind: "boundary" };
    const shell = fingerprint({ ...base, renderFailure: "shell", frames: [frame("a")] });
    expect(fingerprint({ ...base, renderFailure: "window-body", frames: [frame("a")] })).not.toBe(
      shell,
    );
    expect(fingerprint({ ...base, renderFailure: "shell", frames: [frame("b")] })).not.toBe(shell);
    expect(fingerprint({ ...base, renderFailure: "shell", frames: [frame("a", 999)] })).toBe(shell);
    expect(
      fingerprint({ ...base, clientKind: "unhandled-rejection", frames: [frame("a")] }),
    ).not.toBe(shell);
  });

  it("drops customer context and foreign paths without pretending to distinguish unknown shapes", () => {
    const base = { op: "client.diagnostic", errorKind: "timeout" };
    expect(
      fingerprint({
        ...base,
        renderFailure: "CustomerPayroll",
        frames: ["/Users/alice/payroll.js:1:1"],
      }),
    ).toBe(fingerprint(base));
    expect(fingerprint({ ...base, correlationId: "CustomerPayroll" })).toBe(fingerprint(base));
    const input = registeredFailureFingerprintInput({
      ...base,
      moduleLoadFailure: "CustomerPayroll",
    });
    expect(JSON.stringify(input)).not.toContain("CustomerPayroll");
  });

  it("keeps the immutable version-one preimage available for historical report verification", () => {
    const input = registeredFailureFingerprintInput(
      {
        op: "client.diagnostic",
        errorKind: "timeout",
        clientKind: "boundary",
        frames: [frame("a")],
      },
      1,
    );
    expect(input.algorithm).toBeUndefined();
    expect(input.frames).toEqual([]);
    expect(computeDefectFingerprint(input)).toBe(
      computeDefectFingerprint({
        surface: input.surface,
        op: input.op,
        errorKind: input.errorKind,
        frames: [],
      }),
    );
  });
});

describe("registered failure correlation selectors", () => {
  it("treats the shared unknown sentinel as no request identity", () => {
    expect(
      registeredFailureCorrelation({ correlationId: ACTIVITY_LOG_UNKNOWN_CORRELATION_ID }),
    ).toEqual({ childCorrelationIds: [] });
    expect(
      registeredFailureCorrelation({
        correlationId: "known-failure-request",
        parentCorrelationId: ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
      }),
    ).toEqual({ rootCorrelationId: "known-failure-request", childCorrelationIds: [] });
    expect(
      registeredFailureCorrelation({
        correlationId: ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
        parentCorrelationId: "known-parent-request",
      }),
    ).toEqual({ rootCorrelationId: "known-parent-request", childCorrelationIds: [] });
  });
});
