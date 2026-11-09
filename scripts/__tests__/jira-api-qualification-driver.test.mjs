import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../testing/jira-chat-lab/api-qualification-runtime.mjs", () => ({
  dispatchQualification: dispatch,
  qualificationWitness: vi.fn(),
}));
vi.mock("../testing/jira-chat-lab/chat-read.mjs", () => ({
  withModelFreeJira: vi.fn(),
  prepareModelFreeChat: vi.fn(),
}));
import { runQualificationCase } from "../testing/jira-chat-lab/api-qualification.mjs";
import { qualificationDigest } from "../testing/jira-chat-lab/api-qualification-evidence.mjs";

const directories = [];
afterEach(() => {
  directories.forEach((directory) => rmSync(directory, { recursive: true, force: true }));
  directories.length = 0;
  vi.resetAllMocks();
});
function directory() {
  const result = mkdtempSync(join(tmpdir(), "keiko-ac7-driver-"));
  directories.push(result);
  return result;
}
const primary = { tool: "jira.projects", identity: "GET /rest/api/2/project" };
const report = {
  runId: "synthetic-run",
  sourceRevision: "a".repeat(40),
  release: "10.3.26",
  imageDigest: "b".repeat(64),
  file: "qualification-synthetic.json",
};
function attempt(identity = primary.identity, mutation = false) {
  const binding = { identity, contractDigest: "c".repeat(64) };
  return {
    binding,
    mutation,
    dispatch: {
      kind: "settled",
      result: { status: "completed", data: { operationBinding: binding, outcome: "succeeded" } },
      receipt: { status: "completed", budgetDisposition: "committed", effectStarted: true },
    },
    witness: { blocked: 0, responses: [{ status: 200, truncated: false }] },
    ...(mutation ? { journal: { phase: "settled", outcome: "succeeded" } } : {}),
  };
}
const verified = { matched: true, assertionCount: 2 };
const witness = { arm: vi.fn(), snapshot: () => ({ blocked: 1, responses: [] }) };
function specification(fixture) {
  return {
    ...primary,
    arguments: () => ({ selected: fixture.selected }),
    readback: async () => verified,
  };
}
it("resolves arguments after held preparation and keeps the frozen primary witness", async () => {
  const fixture = {};
  dispatch.mockImplementation(async (_context, _chat, _specification, argumentsForCall) => {
    expect(typeof argumentsForCall).toBe("function");
    fixture.selected = "prepared-current-resource";
    expect(argumentsForCall()).toEqual({ selected: fixture.selected });
    return attempt();
  });
  const evidence = await runQualificationCase(
    {},
    {},
    specification(fixture),
    fixture,
    witness,
    directory(),
    report,
  );
  expect(evidence.runtimeAvailability).toBe("executable");
  expect(evidence.witness.blocked).toBe(0);
});
it("persists auxiliary receipt, settled journal and native readback without raw product content", async () => {
  const output = directory();
  const auxiliary = attempt("POST /rest/api/2/issue", true);
  auxiliary.dispatch.result.data.syntheticContent = "private synthetic payload";
  dispatch.mockResolvedValue({
    ...attempt(),
    auxiliaries: [
      {
        tool: "jira.create",
        identity: auxiliary.binding.identity,
        attempted: auxiliary,
        readback: verified,
      },
    ],
  });
  const evidence = await runQualificationCase(
    {},
    {},
    specification({}),
    {},
    witness,
    output,
    report,
  );
  expect(evidence.auxiliaryReferences).toHaveLength(1);
  const text = readFileSync(join(output, evidence.auxiliaryReferences[0]), "utf8");
  const stored = JSON.parse(text);
  expect(stored.runtimeAvailability).toBe("executable");
  expect(stored.journal).toMatchObject({ phase: "settled", outcome: "succeeded" });
  expect(stored.receipt.budgetDisposition).toBe("committed");
  expect(stored.readback).toEqual(verified);
  expect(text).not.toContain("private synthetic payload");
  expect(readdirSync(output).some((name) => name.endsWith(".pending.json"))).toBe(false);
});
it("retains native readback obtained before the private session's canonical cleanup", async () => {
  const selected = specification({});
  selected.readback = vi.fn(async () => {
    throw new TypeError("The private session is already closed");
  });
  dispatch.mockResolvedValue({ ...attempt(), readback: verified });
  const evidence = await runQualificationCase({}, {}, selected, {}, witness, directory(), report);
  expect(evidence.runtimeAvailability).toBe("executable");
  expect(evidence.readback).toEqual(verified);
  expect(selected.readback).not.toHaveBeenCalled();
});
it("retains a reconciliation marker when an auxiliary lacks independent proof", async () => {
  const output = directory();
  dispatch.mockResolvedValue({
    ...attempt(),
    auxiliaries: [
      {
        tool: "jira.create",
        identity: "POST /rest/api/2/issue",
        attempted: attempt("POST /rest/api/2/issue", true),
        readback: { matched: true, assertionCount: 0 },
      },
    ],
  });
  await expect(
    runQualificationCase({}, {}, specification({}), {}, witness, output, report),
  ).rejects.toThrow("Auxiliary evidence");
  expect(readdirSync(output)).toContain(
    `${qualificationDigest(primary.identity).slice(0, 24)}.pending.json`,
  );
});
it("retains a reconciliation marker for an unsettled native write", async () => {
  const output = directory();
  dispatch.mockResolvedValue({
    ...attempt(),
    journal: { phase: "dispatched", outcome: "unknown" },
  });
  await expect(
    runQualificationCase({}, {}, specification({}), {}, witness, output, report),
  ).rejects.toThrow("Uncertain native effect");
  expect(readdirSync(output).some((name) => name.endsWith(".pending.json"))).toBe(true);
});
it("grades a settled 404 write on a release that does not publish it without a reconcile stop", async () => {
  const output = directory();
  const selected = {
    ...specification({}),
    readback: async () => ({ capabilityAbsent: true, status: 404, matched: undefined }),
  };
  const refused = attempt(primary.identity, true);
  refused.dispatch.result = {
    status: "failed",
    data: { operationBinding: refused.binding, outcome: "unknown", reason: "not-found" },
  };
  refused.dispatch.receipt.status = "failed";
  refused.witness.responses = [{ status: 404, truncated: false }];
  refused.journal = { phase: "settled", outcome: "unknown", httpStatus: 404 };
  dispatch.mockResolvedValue(refused);
  const evidence = await runQualificationCase({}, {}, selected, {}, witness, output, report);
  expect(evidence.runtimeAvailability).toBe("unavailable");
  expect(readdirSync(output).some((name) => name.endsWith(".pending.json"))).toBe(false);
});
it("still stops on an unknown 404 write that carries no release-absence proof", async () => {
  const output = directory();
  const refused = attempt(primary.identity, true);
  refused.dispatch.result = {
    status: "failed",
    data: { operationBinding: refused.binding, outcome: "unknown", reason: "not-found" },
  };
  refused.dispatch.receipt.status = "failed";
  refused.witness.responses = [{ status: 404, truncated: false }];
  refused.journal = { phase: "settled", outcome: "unknown", httpStatus: 404 };
  dispatch.mockResolvedValue(refused);
  await expect(
    runQualificationCase({}, {}, specification({}), {}, witness, output, report),
  ).rejects.toThrow("Uncertain native effect");
});
it("grades a settled, independently reproduced 403 write as denied without a reconcile stop", async () => {
  const output = directory();
  const selected = {
    ...specification({}),
    readback: async () => ({ permissionDenied: true, status: 403 }),
  };
  const refused = attempt(primary.identity, true);
  refused.dispatch.result = {
    status: "failed",
    data: { operationBinding: refused.binding, outcome: "unknown", reason: "permission-denied" },
  };
  refused.dispatch.receipt.status = "failed";
  refused.witness.responses = [{ status: 403, truncated: false }];
  refused.journal = { phase: "settled", outcome: "unknown", httpStatus: 403 };
  dispatch.mockResolvedValue(refused);
  const evidence = await runQualificationCase({}, {}, selected, {}, witness, output, report);
  expect(evidence.runtimeAvailability).toBe("denied");
  expect(readdirSync(output).some((name) => name.endsWith(".pending.json"))).toBe(false);
  // Without the independent reproduction the same 403 still stops the run.
  const unproven = { ...specification({}), readback: async () => ({ matched: false }) };
  dispatch.mockResolvedValue(refused);
  await expect(
    runQualificationCase({}, {}, unproven, {}, witness, directory(), report),
  ).rejects.toThrow("Uncertain native effect");
});
it.each([
  [[{ status: 403, truncated: false }], false],
  [
    [
      { status: 403, truncated: false },
      { status: 200, truncated: false },
    ],
    true,
  ],
  [[], true],
])(
  "continues after a failed dispatch only when every native response was a 4xx refusal",
  async (responses, stops) => {
    const output = directory();
    dispatch.mockRejectedValue(new TypeError("Settled outcome unknown"));
    const refusing = {
      arm: vi.fn(),
      effectsStarted: () => 1,
      snapshot: () => ({ blocked: 0, responses }),
    };
    const outcome = runQualificationCase({}, {}, specification({}), {}, refusing, output, report);
    if (stops) await expect(outcome).rejects.toThrow("Uncertain native effect");
    else await expect(outcome).resolves.toMatchObject({ runtimeAvailability: "unknown" });
  },
);
