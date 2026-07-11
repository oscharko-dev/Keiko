// Issue #2214 — governance + redaction tests for the agent-authorized verification route. Hermetic:
// no real sandbox spawn (the VerificationRunnerManager is faked), no network. The route resolves the
// Authority Envelope against the live singleton registry using real `new Date()`, so envelopes are
// registered with a far-future expiry and a generous runtime budget, then resolved in the same tick.

import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_SCHEMA_VERSION,
  EDITOR_AGENT_SCHEMA_VERSION,
  type CodingWorkbenchActionClass,
  type CodingWorkbenchAuthorityEnvelope,
  type EditorAgentActionPolicyDecision,
  type EditorAgentSessionSnapshot,
  type VerificationReport,
} from "@oscharko-dev/keiko-contracts";
import type { RouteContext } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { _resetEditorAgentAuditForTests, listEditorAgentActionAudit } from "./agentActionAudit.js";
import {
  editorAgentAuthorityRegistry,
  editorAgentWorkspaceRootDigest,
} from "./agentAuthorityRegistry.js";
import { editorAgentRegistry } from "./agentSessionRegistry.js";
import { handleEditorAgentVerificationRun } from "./agentVerificationRoute.js";
import type { VerificationRunInput, VerificationRunnerManager } from "./verificationRunner.js";

const ROOT = "/repo";
const SESSION_ID = "session-1";
const CEILING = "autonomous-delivery";
// A valid envelope that grants every action class EXCEPT "verification". Dropping only that class
// keeps every commandPolicy/networkPolicy/connectorScope consistency rule satisfied (unlike a bare
// ["workspace-read"], which trips validateCommandPolicyActionClassConsistency), while making
// composeEditorAgentActionPolicyDecision deny an execution request the classifier alone would allow.
const WITHOUT_VERIFICATION = CODING_WORKBENCH_ACTION_CLASSES.filter((c) => c !== "verification");

function envelope(
  over: Partial<CodingWorkbenchAuthorityEnvelope> = {},
): CodingWorkbenchAuthorityEnvelope {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    runId: "run-1",
    localUser: "local-operator",
    taskRefs: ["issue-2214"],
    workspace: {
      workspaceId: "workspace-1",
      rootLabel: "workspace",
      rootDigest: editorAgentWorkspaceRootDigest(ROOT),
    },
    branch: {
      baseRef: "dev",
      headRef: "local-workspace",
      allowDetachedHead: false,
      allowedPrefixes: ["local-"],
    },
    requestedMode: CEILING,
    deploymentCeiling: CEILING,
    effectiveMode: CEILING,
    runtimeSource: "keiko-sidecar",
    actionClasses: CODING_WORKBENCH_ACTION_CLASSES,
    connectorScopes: [],
    modelProfile: {
      profileId: "profile-1",
      source: "keiko-model-gateway",
      supportsStreaming: true,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "governed",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 60_000,
      requirePerCommandApproval: false,
    },
    networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
    gates: ["human-approval", "branch-allowlist"],
    budget: {
      maxRuntimeMs: 3_600_000,
      maxToolCalls: 20,
      maxPromptTokens: 10_000,
      maxPatchBytes: 65_536,
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
    approvalProofDigest: "a".repeat(64),
    ...over,
  };
}

function registerAuthority(
  actionClasses?: readonly CodingWorkbenchActionClass[],
  over: Partial<CodingWorkbenchAuthorityEnvelope> = {},
): {
  runId: string;
  envelopeDigest: string;
} {
  const registration = editorAgentAuthorityRegistry.register(
    envelope({ ...over, ...(actionClasses === undefined ? {} : { actionClasses }) }),
    CEILING,
    new Date().toISOString(),
  );
  if (!registration.ok) throw new Error("test envelope registration failed");
  return registration.authorityRef;
}

function snapshot(): EditorAgentSessionSnapshot {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    sessionId: SESSION_ID,
    windowId: "window-1",
    workspaceRoot: ROOT,
    activePaneId: "pane-1",
    panes: [{ paneId: "pane-1", activeFile: "src/a.ts", openFiles: ["src/a.ts"] }],
    dirtyFiles: [],
    activeFile: "src/a.ts",
    cursor: null,
    selection: null,
    diagnosticsSummary: null,
    textMode: "none",
    updatedAt: 1,
  };
}

// A failed report carrying a SECRET-shaped outputSummary + argv/command; the redaction projection must
// drop all of it and keep only enums, counts, durations, and structured locations.
function failingReport(): VerificationReport {
  return {
    workspaceRoot: ROOT,
    overallStatus: "failed",
    startedAtMs: 1,
    durationMs: 42,
    counts: {
      passed: 0,
      failed: 1,
      skipped: 0,
      denied: 0,
      "timed-out": 0,
      cancelled: 0,
      "resource-exceeded": 0,
    },
    results: [
      {
        kind: "typecheck",
        scriptName: "typecheck",
        command: "npm",
        args: ["run", "typecheck", "SECRET_VALUE"],
        status: "failed",
        exitCode: 2,
        signal: null,
        durationMs: 42,
        truncated: false,
        redacted: true,
        outputSummary: "SECRET_VALUE digest",
        appliedLimits: [],
        // The location message is a producer-redacted, content-free compiler diagnostic — it IS
        // surfaced to the agent, so it must never carry a secret (unlike outputSummary/argv, dropped).
        locations: [{ file: "src/a.ts", line: 3, column: 5, message: "TS2322 type mismatch" }],
      },
    ],
  };
}

class FakeManager implements VerificationRunnerManager {
  public calls = 0;
  public lastInput: VerificationRunInput | undefined;
  public lastSignal: AbortSignal | undefined;
  public report: VerificationReport = failingReport();
  public failWith: Error | undefined;
  public onRun:
    ((input: VerificationRunInput, signal: AbortSignal) => Promise<VerificationReport>) | undefined;

  public readonly discover = (): never => {
    throw new Error("discover not exercised");
  };
  public readonly execute = (): never => {
    throw new Error("execute not exercised");
  };
  public readonly abort = (): boolean => false;
  public readonly inFlightCount = (): number => 0;
  public readonly subscribe = (): (() => void) => (): void => undefined;
  public readonly runToReport = (
    input: VerificationRunInput,
    signal: AbortSignal,
  ): Promise<VerificationReport> => {
    this.calls += 1;
    this.lastInput = input;
    this.lastSignal = signal;
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    if (this.onRun !== undefined) return this.onRun(input, signal);
    return Promise.resolve(this.report);
  };
}

function deps(manager: VerificationRunnerManager | undefined): UiHandlerDeps {
  return {
    verificationRunner: manager,
    autonomousDeliveryDeploymentCeiling: CEILING,
  } as UiHandlerDeps;
}

function fakeReq(body: Record<string, unknown>): IncomingMessage {
  const req = Object.assign(new EventEmitter(), {
    aborted: false,
    complete: false,
    destroyed: false,
  }) as unknown as IncomingMessage;
  queueMicrotask(() => {
    req.emit("data", Buffer.from(JSON.stringify(body), "utf8"));
    (req as { complete: boolean }).complete = true;
    req.emit("end");
  });
  return req;
}

function routeContext(body: Record<string, unknown>): RouteContext {
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
  }) as unknown as ServerResponse;
  return {
    req: fakeReq(body),
    res,
    params: {},
    url: new URL("http://127.0.0.1:1983/api/editor/verification/agent-runs"),
  };
}

function ctx(body: Record<string, unknown>): RouteContext {
  return routeContext(body);
}

function resultBody(result: { status: number; body: unknown }): Record<string, unknown> {
  return (result.body as { result: Record<string, unknown> }).result;
}

beforeEach(() => {
  editorAgentRegistry.reset();
  editorAgentAuthorityRegistry.reset();
  _resetEditorAgentAuditForTests();
  editorAgentRegistry.registerSnapshot(snapshot());
});

afterEach(() => {
  editorAgentRegistry.reset();
  editorAgentAuthorityRegistry.reset();
  _resetEditorAgentAuditForTests();
});

describe("handleEditorAgentVerificationRun preconditions", () => {
  it("503s when the verification runner is not configured", async () => {
    const authorityRef = registerAuthority();
    const result = await handleEditorAgentVerificationRun(
      ctx({ schemaVersion: "1", sessionId: SESSION_ID, kind: "typecheck", authorityRef }),
      deps(undefined),
    );
    expect(result).toMatchObject({ status: 503 });
  });

  it("400s on a malformed request body", async () => {
    const authorityRef = registerAuthority(undefined, {
      budget: {
        maxRuntimeMs: 3_600_000,
        maxToolCalls: 1,
        maxPromptTokens: 10_000,
        maxPatchBytes: 65_536,
      },
    });
    const manager = new FakeManager();
    const result = await handleEditorAgentVerificationRun(
      ctx({
        schemaVersion: "1",
        sessionId: SESSION_ID,
        kind: "targeted-test",
        authorityRef,
      }),
      deps(manager),
    );
    expect(result).toMatchObject({ status: 400 });
    expect(manager.calls).toBe(0);
    expect(listEditorAgentActionAudit(SESSION_ID)).toHaveLength(0);

    const valid = await handleEditorAgentVerificationRun(
      ctx({ schemaVersion: "1", sessionId: SESSION_ID, kind: "typecheck", authorityRef }),
      deps(manager),
    );
    expect(valid).toMatchObject({ status: 200 });
    expect(manager.calls).toBe(1);
  });

  it("404s when no governed session matches the request", async () => {
    editorAgentRegistry.reset();
    const authorityRef = registerAuthority();
    const result = await handleEditorAgentVerificationRun(
      ctx({ schemaVersion: "1", sessionId: SESSION_ID, kind: "typecheck", authorityRef }),
      deps(new FakeManager()),
    );
    expect(result).toMatchObject({ status: 404 });
  });
});

describe("handleEditorAgentVerificationRun governance (AC2–AC4)", () => {
  // AC2 — the classifier's denial (a deny-listed target) is stricter than the fully-permissive
  // envelope; the composed result is the classifier's denial and the run never starts.
  it("lets the stricter classifier denial win over a permissive envelope, and does not run", async () => {
    const manager = new FakeManager();
    const authorityRef = registerAuthority(CODING_WORKBENCH_ACTION_CLASSES);
    const result = await handleEditorAgentVerificationRun(
      ctx({
        schemaVersion: "1",
        sessionId: SESSION_ID,
        kind: "targeted-test",
        targetPath: ".env",
        authorityRef,
      }),
      deps(manager),
    );
    expect(manager.calls).toBe(0);
    expect(resultBody(result)).toMatchObject({
      outcome: "not-run",
      disposition: "denied",
      reason: "denied-sensitive-path",
    });
  });

  // AC3 — the classifier allows a clean target, but the envelope does not grant the "verification"
  // action class; the composed result is the envelope's denial and the run never starts.
  it("lets the stricter envelope ceiling win over a permissive classifier, and does not run", async () => {
    const manager = new FakeManager();
    const authorityRef = registerAuthority(WITHOUT_VERIFICATION);
    const result = await handleEditorAgentVerificationRun(
      ctx({ schemaVersion: "1", sessionId: SESSION_ID, kind: "typecheck", authorityRef }),
      deps(manager),
    );
    expect(manager.calls).toBe(0);
    expect(resultBody(result)).toMatchObject({ outcome: "not-run", disposition: "denied" });
    expect(resultBody(result).reason).toBe("mode-policy-denied");
  });

  // AC4 — a denied disposition provably prevents dispatch: the mocked runner is never called.
  it("does not request a run when authority resolution fails", async () => {
    const manager = new FakeManager();
    const result = await handleEditorAgentVerificationRun(
      ctx({
        schemaVersion: "1",
        sessionId: SESSION_ID,
        kind: "typecheck",
        authorityRef: { runId: "unknown", envelopeDigest: "b".repeat(64) },
      }),
      deps(manager),
    );
    expect(manager.calls).toBe(0);
    expect(resultBody(result)).toMatchObject({ outcome: "not-run", disposition: "denied" });
  });

  it("does not dispatch a review-required request", async () => {
    const manager = new FakeManager();
    const authorityRef = registerAuthority();
    const reviewRequired: EditorAgentActionPolicyDecision = {
      disposition: "review-required",
      effectClass: "execution",
      origin: "agent",
      reviewReason: "mode-approval-required",
    };
    const result = await handleEditorAgentVerificationRun(
      ctx({ schemaVersion: "1", sessionId: SESSION_ID, kind: "typecheck", authorityRef }),
      deps(manager),
      { decide: () => reviewRequired },
    );
    expect(manager.calls).toBe(0);
    expect(resultBody(result)).toEqual({
      outcome: "not-run",
      disposition: "review-required",
      reason: "mode-approval-required",
    });
  });
});

describe("handleEditorAgentVerificationRun success + redaction (AC6)", () => {
  it("runs once for an allowed request and returns a redacted, report-shaped result", async () => {
    const manager = new FakeManager();
    const authorityRef = registerAuthority();
    const result = await handleEditorAgentVerificationRun(
      ctx({ schemaVersion: "1", sessionId: SESSION_ID, kind: "typecheck", authorityRef }),
      deps(manager),
    );
    expect(manager.calls).toBe(1);
    expect(manager.lastInput).toMatchObject({ projectId: ROOT, kinds: ["typecheck"] });
    const body = resultBody(result);
    expect(body).toMatchObject({
      outcome: "completed",
      report: {
        overallStatus: "failed",
        counts: { failed: 1 },
        steps: [{ kind: "typecheck", status: "failed", durationMs: 42 }],
      },
    });
    // AC6 — the raw outputSummary/command/argv never leak through the tool's mapping layer.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SECRET_VALUE");
    expect(serialized).not.toContain("outputSummary");
    expect(serialized).not.toContain('"command"');
    // Structured, content-free failure locations DO pass through so the agent can act.
    expect(body).toMatchObject({
      report: { steps: [{ locations: [{ file: "src/a.ts", line: 3 }] }] },
    });
  });

  it("returns a completed report even when the run itself fails (test failures are not route errors)", async () => {
    const manager = new FakeManager();
    manager.report = { ...failingReport(), overallStatus: "passed" };
    const authorityRef = registerAuthority();
    const result = await handleEditorAgentVerificationRun(
      ctx({ schemaVersion: "1", sessionId: SESSION_ID, kind: "typecheck", authorityRef }),
      deps(manager),
    );
    expect(resultBody(result)).toMatchObject({ outcome: "completed" });
  });
});

describe("handleEditorAgentVerificationRun audit (AC5)", () => {
  it("records exactly one content-free audit entry for an admitted run", async () => {
    const manager = new FakeManager();
    const authorityRef = registerAuthority();
    await handleEditorAgentVerificationRun(
      ctx({ schemaVersion: "1", sessionId: SESSION_ID, kind: "typecheck", authorityRef }),
      deps(manager),
    );
    const records = listEditorAgentActionAudit(SESSION_ID);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record).toMatchObject({
      actionType: "requestVerification",
      effectClass: "execution",
      mutating: false,
      disposition: "allowed",
      outcome: "queued",
    });
    // Content-free: no raw output, no counts of the verification's own pass/fail results.
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("SECRET_VALUE");
    expect(serialized).not.toContain("outputSummary");
  });

  it("writes the admission audit before dispatch", async () => {
    const manager = new FakeManager();
    manager.onRun = (): Promise<VerificationReport> => {
      expect(listEditorAgentActionAudit(SESSION_ID)).toMatchObject([
        { actionType: "requestVerification", disposition: "allowed", outcome: "queued" },
      ]);
      return Promise.resolve(failingReport());
    };
    const authorityRef = registerAuthority();
    await handleEditorAgentVerificationRun(
      ctx({ schemaVersion: "1", sessionId: SESSION_ID, kind: "typecheck", authorityRef }),
      deps(manager),
    );
    expect(manager.calls).toBe(1);
  });

  it("fails closed without dispatch when the mandatory admission audit cannot be written", async () => {
    const manager = new FakeManager();
    const authorityRef = registerAuthority();
    const result = await handleEditorAgentVerificationRun(
      ctx({ schemaVersion: "1", sessionId: SESSION_ID, kind: "typecheck", authorityRef }),
      deps(manager),
      { audit: () => null },
    );
    expect(result).toMatchObject({ status: 503 });
    expect(manager.calls).toBe(0);
  });

  it("rolls back the authority charge when the admission audit fails", async () => {
    const manager = new FakeManager();
    const authorityRef = registerAuthority(undefined, {
      budget: {
        maxRuntimeMs: 3_600_000,
        maxToolCalls: 1,
        maxPromptTokens: 10_000,
        maxPatchBytes: 65_536,
      },
    });
    const request = { schemaVersion: "1", sessionId: SESSION_ID, kind: "typecheck", authorityRef };

    const failedAudit = await handleEditorAgentVerificationRun(ctx(request), deps(manager), {
      audit: () => null,
    });
    const retry = await handleEditorAgentVerificationRun(ctx(request), deps(manager));

    expect(failedAudit).toMatchObject({ status: 503 });
    expect(retry).toMatchObject({ status: 200 });
    expect(manager.calls).toBe(1);
  });

  it("retains the admission audit when the runner fails", async () => {
    const manager = new FakeManager();
    manager.failWith = new Error("runner failed");
    const authorityRef = registerAuthority();
    await expect(
      handleEditorAgentVerificationRun(
        ctx({ schemaVersion: "1", sessionId: SESSION_ID, kind: "typecheck", authorityRef }),
        deps(manager),
      ),
    ).rejects.toThrow("runner failed");
    expect(listEditorAgentActionAudit(SESSION_ID)).toMatchObject([
      { actionType: "requestVerification", disposition: "allowed", outcome: "queued" },
    ]);
  });

  it("records exactly one audit entry for a denied request", async () => {
    const manager = new FakeManager();
    const authorityRef = registerAuthority(WITHOUT_VERIFICATION);
    await handleEditorAgentVerificationRun(
      ctx({ schemaVersion: "1", sessionId: SESSION_ID, kind: "typecheck", authorityRef }),
      deps(manager),
    );
    const records = listEditorAgentActionAudit(SESSION_ID);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      actionType: "requestVerification",
      disposition: "denied",
      outcome: "conflict",
    });
  });
});

function cancelledReport(): VerificationReport {
  const failing = failingReport();
  const result = failing.results[0];
  if (result === undefined) throw new Error("Expected the fixture report to contain one result.");
  return {
    ...failing,
    overallStatus: "cancelled",
    counts: {
      passed: 0,
      failed: 0,
      skipped: 0,
      denied: 0,
      "timed-out": 0,
      cancelled: 1,
      "resource-exceeded": 0,
    },
    results: [{ ...result, status: "cancelled" }],
  };
}

function waitForAbort(signal: AbortSignal): Promise<VerificationReport> {
  if (signal.aborted) return Promise.resolve(cancelledReport());
  return new Promise((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve(cancelledReport());
      },
      { once: true },
    );
  });
}

describe("handleEditorAgentVerificationRun disconnect cancellation", () => {
  it.each(["request aborted", "response closed"])(
    "cancels an in-flight run when the %s",
    async (event) => {
      const manager = new FakeManager();
      let started: (() => void) | undefined;
      const didStart = new Promise<void>((resolve) => {
        started = resolve;
      });
      manager.onRun = (_input, signal): Promise<VerificationReport> => {
        started?.();
        return waitForAbort(signal);
      };
      const authorityRef = registerAuthority();
      const context = routeContext({
        schemaVersion: "1",
        sessionId: SESSION_ID,
        kind: "typecheck",
        authorityRef,
      });
      const pending = handleEditorAgentVerificationRun(context, deps(manager));
      await didStart;
      if (event === "request aborted") context.req.emit("aborted");
      else context.res.emit("close");
      await pending;
      expect(manager.lastSignal?.aborted).toBe(true);
    },
  );

  it("does not treat normal request end/close as a disconnect", async () => {
    const manager = new FakeManager();
    const authorityRef = registerAuthority();
    const context = routeContext({
      schemaVersion: "1",
      sessionId: SESSION_ID,
      kind: "typecheck",
      authorityRef,
    });
    manager.onRun = (_input, signal): Promise<VerificationReport> => {
      context.req.emit("close");
      expect(signal.aborted).toBe(false);
      return Promise.resolve(failingReport());
    };
    await handleEditorAgentVerificationRun(context, deps(manager));
    expect(manager.lastSignal?.aborted).toBe(false);
  });
});
