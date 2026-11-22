import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// FAILS BEFORE / PASSES AFTER (#2902 w4b): `readContainedText`'s catch{} used to collapse every
// read failure — including a genuine OS permission denial — into reason "not-found", actively
// mislabeling the failure. Force a permission-denied readFileSync and assert the result is no
// longer reported as "not-found", plus a content-free diagnostic now records which failure fired.
const { readFileSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  readFileSyncMock.mockImplementation((path: unknown, options: unknown) =>
    original.readFileSync(path as string, options as never),
  );
  return { ...original, readFileSync: readFileSyncMock };
});

import { openCodeNativeVerificationKind } from "../opencodeNativePolicy.js";
import type { ProductionCodingRuntimeResolverInput } from "../productionCodingRuntimeResolver.js";
import type { ServerDiagnosticRecord } from "../../diagnostics-log.js";
import {
  ACCEPTANCE_CHECK_COMMAND,
  ACCEPTANCE_STALE_SUFFIX,
  FUNCTIONAL_PLAN_STEP_READ,
  FUNCTIONAL_PLAN_STEP_VERIFY,
  functionalWorkspaceRead,
  NATIVE_VERIFICATION_COMMAND,
  resolveFunctionalChildModelInput,
  scriptedResponse,
  type ScriptState,
} from "./_support.js";

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

  it("rejects malformed complete pairs from untyped harness callers", () => {
    const malformed = [
      { childModelPortFactory, childModelId: null },
      { childModelPortFactory, childModelId: 42 },
      { childModelPortFactory, childModelId: "" },
      { childModelPortFactory, childModelId: "   " },
      { childModelPortFactory, childModelId: " padded-model " },
      { childModelPortFactory: null, childModelId: "functional-model" },
      { childModelPortFactory: 42, childModelId: "functional-model" },
      { childModelPortFactory: {}, childModelId: "functional-model" },
      { childModelPortFactory: "factory", childModelId: "functional-model" },
    ] as const;

    for (const candidate of malformed) {
      expect(() => resolveFunctionalChildModelInput(candidate)).toThrow(
        "functional-child-model-configuration-incomplete",
      );
    }
  });
});

describe("functional browser cancellation hold", () => {
  it("holds the turn only after the verification tool was emitted", () => {
    const script: ScriptState = {
      mode: "productive",
      calls: 0,
      old: "before",
      next: "after",
      holdAfterVerification: true,
    };
    const initial = Array.from({ length: 3 }, () => scriptedResponse(script));
    expect(script.verificationIssued).not.toBe(true);
    expect(initial[0]?.content).toBe(FUNCTIONAL_PLAN_STEP_READ);
    expect(initial[2]?.content).toBe(FUNCTIONAL_PLAN_STEP_VERIFY);
    const verification = scriptedResponse(script);
    expect(script.verificationIssued).toBe(true);
    const held = Array.from({ length: 3 }, () => scriptedResponse(script));

    expect(
      [...initial, verification, ...held].map((response) => response.toolCalls[0]?.name),
    ).toEqual([
      "keiko_workspace_read",
      "question",
      "keiko_changeset_edit",
      "keiko_verification",
      "question",
      "question",
      "question",
    ]);
  });
});

describe("native journey verification (#3901)", () => {
  it("runs a project check the native policy reads as verification evidence", () => {
    // The real-binary journey verifies through the runtime's own `shell`; the run is evidenced only
    // when the production classifier reads the scripted line as a project check.
    expect(openCodeNativeVerificationKind([NATIVE_VERIFICATION_COMMAND])).toBe("typecheck");
  });
});

// #4492: the acceptance turn advances by the tool replies the runtime resends, never by how often
// the model was called, so a title request or a repeated call cannot skip or repeat a step.
describe("functional acceptance turn (#4492)", () => {
  function acceptanceScript(plan?: ScriptState["acceptancePlan"]): ScriptState {
    return {
      mode: "acceptance",
      calls: 0,
      old: "before\n",
      next: "after\n",
      acceptanceTarget: "src/target.js",
      ...(plan === undefined ? {} : { acceptancePlan: plan }),
    };
  }

  function afterReplies(count: number): string {
    return JSON.stringify([
      { role: "user", content: "task" },
      ...Array.from({ length: count }, () => ({ role: "tool", content: "done" })),
    ]);
  }

  function plannedCalls(script: ScriptState): readonly unknown[] {
    return Array.from({ length: 7 }, (_, replies) => {
      const call = scriptedResponse(script, afterReplies(replies)).toolCalls[0];
      return call === undefined ? "answer" : [call.name, call.arguments];
    });
  }

  it("runs a check the production policy reads as the project's tests", () => {
    expect(openCodeNativeVerificationKind([ACCEPTANCE_CHECK_COMMAND])).toBe("test");
  });

  it("fails the check, reads, repairs and checks again", () => {
    const check = ["shell", { command: ACCEPTANCE_CHECK_COMMAND, timeout: 60_000 }];
    expect(plannedCalls(acceptanceScript())).toEqual([
      check,
      ["read", { path: "src/target.js" }],
      ["edit", { path: "src/target.js", oldString: "before\n", newString: "after\n" }],
      check,
      "answer",
      "answer",
      "answer",
    ]);
  });

  it("leaves the check out, or makes it stale with one more edit", () => {
    expect(plannedCalls(acceptanceScript("skip-check")).slice(2, 4)).toEqual([
      ["edit", { path: "src/target.js", oldString: "before\n", newString: "after\n" }],
      "answer",
    ]);
    expect(plannedCalls(acceptanceScript("stale-check")).slice(3, 6)).toEqual([
      ["shell", { command: ACCEPTANCE_CHECK_COMMAND, timeout: 60_000 }],
      [
        "edit",
        {
          path: "src/target.js",
          oldString: "after\n",
          newString: `after\n${ACCEPTANCE_STALE_SUFFIX}`,
        },
      ],
      "answer",
    ]);
  });

  it("answers a title request, and a turn without a target, without a tool", () => {
    const script = acceptanceScript();
    const title = JSON.stringify([
      { role: "user", content: "Generate a title for this conversation: task" },
    ]);
    expect(scriptedResponse(script, title).toolCalls).toEqual([]);
    expect(scriptedResponse(script, afterReplies(0)).toolCalls[0]?.name).toBe("shell");
    const { acceptanceTarget: _omitted, ...untargeted } = script;
    expect(scriptedResponse(untargeted, afterReplies(0)).toolCalls).toEqual([]);
  });
});

describe("functional workspace read failure classification (#2902 w4b)", () => {
  const roots: string[] = [];

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "keiko-functional-read-"));
    roots.push(root);
    return root;
  }

  afterEach(() => {
    readFileSyncMock.mockClear();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("reports a genuinely missing file as not-found, with a diagnostic recorded", async () => {
    const root = makeRoot();
    const records: ServerDiagnosticRecord[] = [];
    const port = functionalWorkspaceRead(() => root, { record: (record) => records.push(record) });

    const result = await port.readText({ relativePath: "does-not-exist.txt" });

    expect(result).toEqual({ ok: false, reason: "not-found" });
    expect(records).toHaveLength(1);
    expect(records[0]?.message).toBe("functional-workspace-read-not-found");
  });

  it("does NOT mislabel a permission-denied read as not-found (sharpest regression proof)", async () => {
    const root = makeRoot();
    const filePath = join(root, "locked.txt");
    writeFileSync(filePath, "contained-secret-body");
    readFileSyncMock.mockImplementation((): never => {
      throw Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" });
    });
    const records: ServerDiagnosticRecord[] = [];
    const port = functionalWorkspaceRead(() => root, { record: (record) => records.push(record) });

    const result = await port.readText({ relativePath: "locked.txt" });

    // Before the fix this was { ok: false, reason: "not-found" } — actively wrong, since the file
    // exists and is readable-by-path; the failure was a permission denial, not an absence.
    expect(result).toEqual({ ok: false, reason: "denied" });
    expect(result).not.toEqual({ ok: false, reason: "not-found" });
    expect(records).toHaveLength(1);
    expect(records[0]?.message).toBe("functional-workspace-read-permission-denied");
    const serialized = JSON.stringify(records[0]);
    expect(serialized).not.toContain("contained-secret-body");
    expect(serialized).not.toContain(root);
  });
});
