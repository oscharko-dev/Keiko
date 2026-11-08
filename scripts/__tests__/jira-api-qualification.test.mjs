import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import {
  applyQualificationReport,
  classifyQualification,
  matchesNativeIdentity,
  qualificationDigest,
  qualificationSummary,
} from "../testing/jira-chat-lab/api-qualification-evidence.mjs";

const identity = "GET /rest/api/2/project/{projectIdOrKey}";
const binding = { identity, contractDigest: "a".repeat(64) };
function observation() {
  return {
    identity,
    binding,
    dispatch: {
      kind: "settled",
      result: {
        status: "completed",
        data: {
          operationBinding: binding,
          outcome: "succeeded",
        },
      },
      receipt: { status: "completed", budgetDisposition: "committed", effectStarted: true },
    },
    witness: { blocked: 0, responses: [{ status: 200, truncated: false }] },
    readback: { matched: true, assertionCount: 2 },
    mutation: false,
  };
}

describe("native Jira qualification evidence", () => {
  it("recognizes the actual parameter spelling of every inventory identity", () => {
    const ledger = JSON.parse(
      readFileSync(
        new URL("../../docs/local-knowledge/jira-api-coverage/operations.json", import.meta.url),
        "utf8",
      ),
    );
    for (const row of ledger.operations) {
      const concrete = row.path.replace(/\{[^}]+\}/gu, "42");
      expect(matchesNativeIdentity(row.identity, row.method, concrete), row.identity).toBe(true);
    }
  });
  it("refuses success without the real settled effect and budget receipt", () => {
    const o = observation();
    for (const receipt of [
      undefined,
      { ...o.dispatch.receipt, effectStarted: false },
      { ...o.dispatch.receipt, budgetDisposition: "commit-uncertain" },
      { ...o.dispatch.receipt, status: "failed" },
    ])
      expect(classifyQualification({ ...o, dispatch: { ...o.dispatch, receipt } })).toBe("unknown");
  });
  it("requires the exact method, path segments and nonempty target", () => {
    expect(matchesNativeIdentity(identity, "GET", "/rest/api/2/project/KEIKO")).toBe(true);
    for (const path of [
      "/rest/api/2/project/",
      "/rest/api/2/project/KEIKO/role",
      "/rest/api/2/project",
    ])
      expect(matchesNativeIdentity(identity, "GET", path)).toBe(false);
    expect(matchesNativeIdentity(identity, "POST", "/rest/api/2/project/KEIKO")).toBe(false);
  });

  it("requires an independent nonvacuous readback and settled write journal", () => {
    expect(classifyQualification(observation())).toBe("executable");
    expect(
      classifyQualification({ ...observation(), readback: { matched: true, assertionCount: 0 } }),
    ).toBe("unknown");
    expect(classifyQualification({ ...observation(), mutation: true })).toBe("unknown");
    expect(
      classifyQualification({
        ...observation(),
        mutation: true,
        journal: { phase: "acknowledged", outcome: "succeeded" },
      }),
    ).toBe("unknown");
    expect(
      classifyQualification({
        ...observation(),
        mutation: true,
        journal: { phase: "settled", outcome: "succeeded-unconfirmed" },
      }),
    ).toBe("unknown");
  });

  it.each([400, 401, 403, 404, 405, 429, 500])(
    "does not turn native HTTP %i into qualification by itself",
    (status) => {
      const o = observation();
      o.dispatch.result.status = "failed";
      o.dispatch.receipt.status = "failed";
      o.dispatch.result.data.reason = "permission-denied";
      o.witness.responses[0].status = status;
      expect(classifyQualification(o)).toBe("unknown");
    },
  );

  it("requires independent native denial or missing-capability evidence", () => {
    const o = observation();
    o.dispatch.result.status = "failed";
    o.dispatch.receipt.status = "failed";
    o.dispatch.result.data.reason = "permission-denied";
    o.witness.responses[0].status = 403;
    expect(classifyQualification({ ...o, readback: { permissionDenied: true } })).toBe("denied");
    o.witness.responses[0].status = 404;
    expect(classifyQualification({ ...o, readback: { capabilityAbsent: true } })).toBe(
      "unavailable",
    );
    expect(
      classifyQualification({
        ...o,
        witness: { ...o.witness, blocked: 1 },
        readback: { capabilityAbsent: true },
      }),
    ).toBe("unknown");
  });

  it("refuses foreign operation bindings, truncated responses and unobserved calls", () => {
    const o = observation();
    expect(classifyQualification({ ...o, identity: "GET /rest/api/2/project" })).toBe("unknown");
    expect(classifyQualification({ ...o, witness: { blocked: 0, responses: [] } })).toBe("unknown");
    o.witness.responses[0].truncated = true;
    expect(classifyQualification(o)).toBe("unknown");
    o.dispatch.result.data.operationBinding = { identity, contractDigest: "b".repeat(64) };
    expect(classifyQualification(o)).toBe("unknown");
  });

  it("refuses missing/duplicate identities, unqualified reports and cross-head pooling", () => {
    const ledger = {
      operations: [{ identity, runtimeAvailability: "unknown", verificationReferences: [] }],
    };
    const report = {
      schemaVersion: 1,
      sourceRevision: "a".repeat(40),
      inventoryDigest: qualificationDigest([identity]),
      operations: [
        {
          identity,
          runtimeAvailability: "executable",
          verificationReferences: ["report.json#one"],
        },
      ],
    };
    expect(
      applyQualificationReport(ledger, report, report.sourceRevision).operations[0]
        .runtimeAvailability,
    ).toBe("executable");
    for (const change of [
      { sourceRevision: "b".repeat(40) },
      { operations: [] },
      { operations: [...report.operations, ...report.operations] },
      { operations: [{ ...report.operations[0], runtimeAvailability: "unknown" }] },
      { operations: [{ ...report.operations[0], verificationReferences: [] }] },
    ])
      expect(() =>
        applyQualificationReport(ledger, { ...report, ...change }, report.sourceRevision),
      ).toThrow();
    expect(ledger.operations[0].runtimeAvailability).toBe("unknown");
  });

  it("accounts for every actual state and refuses proposed policy decisions", () => {
    expect(
      qualificationSummary([{ runtimeAvailability: "denied" }, { runtimeAvailability: "unknown" }]),
    ).toEqual({ executable: 0, denied: 1, unavailable: 0, unknown: 1 });
    expect(() => qualificationSummary([{ runtimeAvailability: "excluded-by-policy" }])).toThrow();
  });
});

it("never qualifies malformed or missing proof through a matching external readback", () => {
  const o = observation();
  o.mutation = true;
  o.dispatch.result.status = "failed";
  o.dispatch.receipt.status = "failed";
  o.dispatch.result.data.outcome = "succeeded-unconfirmed";
  o.journal = { phase: "settled", outcome: "succeeded-unconfirmed", httpStatus: 200 };
  for (const reason of [undefined, "malformed-payload", "not-found", "permission-denied"]) {
    o.dispatch.result.data.reason = reason;
    expect(classifyQualification(o)).toBe("unknown");
  }
  o.dispatch.result.data.reason = "unavailable";
  expect(classifyQualification(o)).toBe("executable");
  expect(classifyQualification({ ...o, mutation: false })).toBe("unknown");
  const completed = {
    ...o,
    dispatch: {
      ...o.dispatch,
      result: {
        ...o.dispatch.result,
        status: "completed",
        data: { ...o.dispatch.result.data, reason: "malformed-payload" },
      },
      receipt: { ...o.dispatch.receipt, status: "completed" },
    },
  };
  expect(classifyQualification(completed)).toBe("unknown");
  expect(classifyQualification({ ...o, journal: { ...o.journal, httpStatus: 204 } })).toBe(
    "unknown",
  );
});
