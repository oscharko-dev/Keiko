import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { URL } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { qualificationDigest } from "../testing/jira-chat-lab/api-qualification-evidence.mjs";
import { writeQualificationLedger } from "../testing/jira-chat-lab/api-qualification-ledger.mjs";

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
let f;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "jira-qualified-ledger-"));
  roots.push(root);
  const ledger = JSON.parse(
    readFileSync(
      new URL("../../docs/local-knowledge/jira-api-coverage/operations.json", import.meta.url),
      "utf8",
    ),
  );
  const runId = "00000000-0000-4000-8000-000000000001";
  const run = {
    runId,
    sourceRevision: "a".repeat(40),
    release: "10.3.26",
    imageDigest: "d".repeat(64),
  };
  const file = `qualification-${run.release}-${runId}.json`;
  const operations = ledger.operations.map((row) => {
    const tool = row.currentCapabilityIds[0];
    const mutation = ledger.currentCapabilities[tool].effect === "write";
    const binding = { identity: row.identity, contractDigest: "b".repeat(64) };
    const id = qualificationDigest(row.identity).slice(0, 24);
    return {
      ...run,
      id,
      identity: row.identity,
      tool,
      mutation,
      binding,
      runtimeAvailability: "executable",
      resultDigest: "c".repeat(64),
      dispatch: {
        kind: "settled",
        result: { status: "completed", data: { operationBinding: binding, outcome: "succeeded" } },
        receipt: { status: "completed", effectStarted: true, budgetDisposition: "committed" },
      },
      witness: { blocked: 0, responses: [{ status: 200, truncated: false }] },
      journal: mutation ? { phase: "settled", outcome: "succeeded" } : null,
      readback: {
        matched: true,
        assertionCount: 2,
        privateCanary: "synthetic private readback body",
      },
      verificationReferences: [`${file}#${id}`],
    };
  });
  const report = {
    schemaVersion: 1,
    ...run,
    file,
    modelCalls: 0,
    phase: "complete",
    inventoryDigest: qualificationDigest(ledger.operations.map((row) => row.identity)),
    operations,
  };
  const reportPath = join(root, `api-qualification-${runId}`, file);
  mkdirSync(dirname(reportPath));
  const ledgerPath = join(root, "operations.json");
  f = { root, ledger, report, reportPath, ledgerPath, sourceRevision: run.sourceRevision };
  save();
});
function save() {
  writeFileSync(f.ledgerPath, JSON.stringify(f.ledger), { mode: 0o600 });
  writeFileSync(f.reportPath, JSON.stringify(f.report), { mode: 0o600 });
}
it("publishes 439 independently graded rows and body-free readback references from one complete run", async () => {
  const result = await writeQualificationLedger(f);
  const actual = JSON.parse(readFileSync(f.ledgerPath, "utf8"));
  expect(actual.operations).toHaveLength(439);
  expect(actual.operations.every((row) => row.runtimeAvailability === "executable")).toBe(true);
  const archive = readFileSync(join(f.root, result.evidenceFile), "utf8");
  expect(archive).not.toContain("synthetic private readback body");
  expect(JSON.parse(archive).operations[0].readback).toMatchObject({
    matched: true,
    assertionCount: 2,
  });
  expect(actual.operations[0].verificationReferences).toEqual([
    `${result.evidenceFile}#${f.report.operations[0].id}`,
  ]);
  expect(actual.currentCapabilities).toEqual(f.ledger.currentCapabilities);
});
it.each([
  "phase",
  "source",
  "model",
  "missing",
  "duplicate",
  "unknown",
  "policy",
  "run-mix",
  "empty-readback",
  "receipt",
  "unsettled",
  "effect",
])("withholds the ledger on %s evidence", async (kind) => {
  const row = f.report.operations[0];
  const edits = {
    phase: () => {
      f.report.phase = "running";
    },
    source: () => {
      f.report.sourceRevision = "f".repeat(40);
    },
    model: () => {
      f.report.modelCalls = 1;
    },
    missing: () => {
      f.report.operations.pop();
    },
    duplicate: () => {
      f.report.operations[1] = row;
    },
    unknown: () => {
      row.runtimeAvailability = "unknown";
    },
    policy: () => {
      row.runtimeAvailability = "deferred";
    },
    "run-mix": () => {
      row.runId = "00000000-0000-4000-8000-000000000002";
    },
    "empty-readback": () => {
      row.readback.assertionCount = 0;
    },
    receipt: () => {
      row.dispatch.receipt.effectStarted = false;
    },
    unsettled: () => {
      row.journal.phase = "dispatched";
    },
    effect: () => {
      row.mutation = false;
      row.journal = null;
    },
  };
  edits[kind]();
  save();
  const before = readFileSync(f.ledgerPath, "utf8");
  await expect(writeQualificationLedger(f)).rejects.toThrow();
  expect(readFileSync(f.ledgerPath, "utf8")).toBe(before);
});
it("refuses a settled-looking report while a case still requires reconciliation", async () => {
  writeFileSync(join(dirname(f.reportPath), `${f.report.operations[0].id}.pending.json`), "{}", {
    mode: 0o600,
  });
  await expect(writeQualificationLedger(f)).rejects.toThrow();
  expect(JSON.parse(readFileSync(f.ledgerPath, "utf8"))).toEqual(f.ledger);
});
it("does not accept a native validation error as Jira permission or version evidence", async () => {
  const row = f.report.operations[0];
  row.runtimeAvailability = "denied";
  row.dispatch.result.status = "failed";
  row.dispatch.receipt.status = "failed";
  row.dispatch.result.data.reason = "invalid-arguments";
  row.witness.responses[0].status = 400;
  save();
  await expect(writeQualificationLedger(f)).rejects.toThrow();
});

it("publishes proven Jira permission and version refusals without upgrading policy proposals", async () => {
  for (const [index, status] of [
    [0, 403],
    [1, 405],
  ]) {
    const row = f.report.operations[index];
    row.runtimeAvailability = status === 403 ? "denied" : "unavailable";
    row.dispatch.result.status = "failed";
    row.dispatch.receipt.status = "failed";
    row.dispatch.result.data.outcome = "rejected";
    row.dispatch.result.data.reason = status === 403 ? "permission-denied" : "unavailable";
    if (row.mutation) row.journal = { phase: "settled", outcome: "rejected" };
    row.witness.responses[0].status = status;
    row.readback = {
      permissionDenied: status === 403,
      capabilityAbsent: status === 405,
      assertionCount: 1,
    };
  }
  save();
  const result = await writeQualificationLedger(f);
  expect(result.counts).toEqual({ executable: 437, denied: 1, unavailable: 1, unknown: 0 });
});
it("refuses a native denial whose write journal is still dispatched", async () => {
  const row = f.report.operations[0];
  row.runtimeAvailability = "denied";
  row.dispatch.result.status = "failed";
  row.dispatch.receipt.status = "failed";
  row.dispatch.result.data.reason = "permission-denied";
  row.readback = { permissionDenied: true };
  row.witness.responses[0].status = 403;
  row.journal = { phase: "dispatched", outcome: "unknown" };
  save();
  await expect(writeQualificationLedger(f)).rejects.toThrow();
});
it("reuses an identical archive after interruption but refuses a conflicting archive", async () => {
  const first = await writeQualificationLedger(f);
  await expect(writeQualificationLedger(f)).resolves.toEqual(first);
  const before = readFileSync(f.ledgerPath, "utf8");
  writeFileSync(join(f.root, first.evidenceFile), "{}", { mode: 0o600 });
  await expect(writeQualificationLedger(f)).rejects.toThrow();
  expect(readFileSync(f.ledgerPath, "utf8")).toBe(before);
});

it.each(["sourceRevision", "release", "imageDigest"])(
  "refuses a case whose %s belongs to another run",
  async (field) => {
    f.report.operations[0][field] =
      field === "release" ? "11.3.13" : "e".repeat(field === "sourceRevision" ? 40 : 64);
    save();
    await expect(writeQualificationLedger(f)).rejects.toThrow();
    expect(JSON.parse(readFileSync(f.ledgerPath, "utf8"))).toEqual(f.ledger);
  },
);
