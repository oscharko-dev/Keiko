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
  isWorkspaceManifestDigest,
  isWorkspaceManifestRef,
  isWorkspaceRootIdentityDigest,
  isWorkspaceRootRef,
  type CodingWorkbenchActionClass,
  type CodingWorkbenchAuthorityEnvelope,
  type EditorAgentActionPolicyDecision,
  type EditorAgentRootBinding,
  type EditorAgentSessionSnapshot,
  type VerificationReport,
} from "@oscharko-dev/keiko-contracts";
import type { RouteContext } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  createInMemoryUiStore,
  type UiStore,
  type WorkspaceManifestRecordRow,
} from "../store/index.js";
import { _resetEditorAgentAuditForTests, listEditorAgentActionAudit } from "./agentActionAudit.js";
import {
  editorAgentAuthorityRegistry,
  editorAgentWorkspaceRootDigest,
  type EditorAgentAuthorityFailureReason,
} from "./agentAuthorityRegistry.js";
import { editorAgentRegistry } from "./agentSessionRegistry.js";
import {
  handleEditorAgentVerificationRun,
  verificationAuthorityDenyReason,
} from "./agentVerificationRoute.js";
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

function deps(
  manager: VerificationRunnerManager | undefined,
  workspaceTrust: "trusted" | "restricted" = "trusted",
): UiHandlerDeps {
  return {
    verificationRunner: manager,
    autonomousDeliveryDeploymentCeiling: CEILING,
    workspaceScriptTrust: { trustLevelForRoot: () => workspaceTrust },
  } as unknown as UiHandlerDeps;
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

  it("rechecks canonical workspace trust and denies execution before dispatch", async () => {
    const manager = new FakeManager();
    const authorityRef = registerAuthority();
    const request = ctx({
      schemaVersion: "1",
      sessionId: SESSION_ID,
      kind: "typecheck",
      authorityRef,
    });

    const result = await handleEditorAgentVerificationRun(request, deps(manager, "restricted"));

    expect(manager.calls).toBe(0);
    expect(resultBody(result)).toEqual({
      outcome: "not-run",
      disposition: "denied",
      reason: "workspace-restricted",
    });
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

// Issue #2624 (Wave-2 pre-merge audit of epic #2285) — the root-binding guards on this route shipped
// with zero coverage, and two of them were wrong. Denial evidence was attributed to the root the
// CALLER supplied whenever the session held none, and it recorded the caller's `targetPath` while the
// sibling actions route deliberately suppresses it. Evidence a caller can steer is not evidence.
const SESSION_ROOT_REF = "root-alpha";
const SESSION_ROOT_DIGEST = "c".repeat(64);
const CALLER_ROOT_REF = "root-attacker";
const CALLER_ROOT_DIGEST = "d".repeat(64);
const MANIFEST_REF = "manifest-2624";
const MANIFEST_DIGEST = "e".repeat(64);
const BOUND_SESSION_ID = "session-bound";

// The workspace refs and digests are branded contract types. Narrowing the fixture through the real
// guards keeps it honest: a binding the parser would reject at the route edge cannot be built here.
function branded<T>(
  value: string,
  guard: (candidate: unknown) => candidate is T,
  label: string,
): T {
  if (!guard(value)) throw new Error(`test fixture is not a valid ${label}`);
  return value;
}

function rootBinding(rootRef: string, rootIdentityDigest: string): EditorAgentRootBinding {
  return {
    workspaceId: "workspace-1",
    manifestRef: branded(MANIFEST_REF, isWorkspaceManifestRef, "manifestRef"),
    manifestRevision: 3,
    manifestDigest: branded(MANIFEST_DIGEST, isWorkspaceManifestDigest, "manifestDigest"),
    rootRef: branded(rootRef, isWorkspaceRootRef, "rootRef"),
    rootIdentityDigest: branded(
      rootIdentityDigest,
      isWorkspaceRootIdentityDigest,
      "rootIdentityDigest",
    ),
  };
}

function sessionRootBinding(): EditorAgentRootBinding {
  return rootBinding(SESSION_ROOT_REF, SESSION_ROOT_DIGEST);
}

function callerRootBinding(): EditorAgentRootBinding {
  return rootBinding(CALLER_ROOT_REF, CALLER_ROOT_DIGEST);
}

// A session whose authorized root the server holds itself. `registerSnapshot` refuses to replace an
// existing session, so this uses an id of its own rather than the shared bindingless SESSION_ID.
function registerBoundSession(): void {
  const bound: EditorAgentSessionSnapshot = {
    ...snapshot(),
    sessionId: BOUND_SESSION_ID,
    rootBinding: sessionRootBinding(),
  };
  expect(editorAgentRegistry.registerSnapshot(bound)).toBe(true);
}

function auditRecord(sessionId: string): Record<string, unknown> | undefined {
  return listEditorAgentActionAudit(sessionId).at(-1) as Record<string, unknown> | undefined;
}

describe("handleEditorAgentVerificationRun root-binding guards (#2624)", () => {
  it("attributes a boundary denial to the session, never to the caller-supplied root", async () => {
    // The session holds no authorized root, so the server has nothing to attribute the denial to. A
    // hostile caller names one anyway; the ledger recorded exactly that value, which let the caller
    // choose the root its own denial was filed against.
    const manager = new FakeManager();
    const authorityRef = registerAuthority();
    const result = await handleEditorAgentVerificationRun(
      ctx({
        schemaVersion: "1",
        sessionId: SESSION_ID,
        kind: "typecheck",
        authorityRef,
        rootBinding: callerRootBinding(),
      }),
      deps(manager),
    );
    expect(resultBody(result)).toEqual({
      outcome: "not-run",
      disposition: "denied",
      reason: "root-binding-invalid",
    });
    const record = auditRecord(SESSION_ID);
    expect(record).toMatchObject({ disposition: "denied", denyReason: "root-binding-invalid" });
    expect(record).not.toHaveProperty("rootAttribution");
    expect(JSON.stringify(record)).not.toContain(CALLER_ROOT_REF);
    expect(JSON.stringify(record)).not.toContain(CALLER_ROOT_DIGEST);
    expect(manager.calls).toBe(0);
  });

  it("keeps a boundary denial free of the caller's target path", async () => {
    const manager = new FakeManager();
    const authorityRef = registerAuthority();
    const result = await handleEditorAgentVerificationRun(
      ctx({
        schemaVersion: "1",
        sessionId: SESSION_ID,
        kind: "targeted-test",
        targetPath: "src/a.ts",
        authorityRef,
        rootBinding: callerRootBinding(),
      }),
      deps(manager),
    );
    expect(resultBody(result)).toMatchObject({
      outcome: "not-run",
      reason: "root-binding-invalid",
    });
    const record = auditRecord(SESSION_ID);
    expect(record).not.toHaveProperty("targetPath");
    expect(JSON.stringify(record)).not.toContain("src/a.ts");
    expect(manager.calls).toBe(0);
  });

  it("still records the target path for a denial the root boundary did not raise", async () => {
    // Positive control for the suppression above: only a BOUNDARY denial loses its target. Blanket
    // removal would satisfy the previous test while dropping evidence the ledger is meant to keep.
    const manager = new FakeManager();
    const authorityRef = registerAuthority(WITHOUT_VERIFICATION);
    await handleEditorAgentVerificationRun(
      ctx({
        schemaVersion: "1",
        sessionId: SESSION_ID,
        kind: "targeted-test",
        targetPath: "src/a.ts",
        authorityRef,
      }),
      deps(manager),
    );
    expect(auditRecord(SESSION_ID)).toMatchObject({
      disposition: "denied",
      denyReason: "mode-policy-denied",
      targetPath: "src/a.ts",
    });
    expect(manager.calls).toBe(0);
  });

  it("attributes an admitted run to the root the session authorized", async () => {
    // Positive control for the attribution rule: dropping attribution outright would satisfy the
    // absence assertions above, so the admitted path must still name the server-held root.
    registerBoundSession();
    const manager = new FakeManager();
    const authorityRef = registerAuthority();
    const result = await handleEditorAgentVerificationRun(
      ctx({
        schemaVersion: "1",
        sessionId: BOUND_SESSION_ID,
        kind: "typecheck",
        authorityRef,
        rootBinding: sessionRootBinding(),
      }),
      deps(manager),
    );
    expect(resultBody(result)).toMatchObject({ outcome: "completed" });
    expect(manager.calls).toBe(1);
    expect(auditRecord(BOUND_SESSION_ID)).toMatchObject({
      disposition: "allowed",
      outcome: "queued",
      rootAttribution: {
        rootRef: SESSION_ROOT_REF,
        rootIdentityDigest: SESSION_ROOT_DIGEST,
      },
    });
  });

  it("files a cross-root dispatch against the session root and drops its target", async () => {
    // The sharpest form of the finding: the caller names a DIFFERENT root than the session holds.
    // The denial belongs to the root the server authorized, and names no path.
    registerBoundSession();
    const manager = new FakeManager();
    const authorityRef = registerAuthority();
    const result = await handleEditorAgentVerificationRun(
      ctx({
        schemaVersion: "1",
        sessionId: BOUND_SESSION_ID,
        kind: "targeted-test",
        targetPath: "src/a.ts",
        authorityRef,
        rootBinding: callerRootBinding(),
      }),
      deps(manager),
    );
    expect(resultBody(result)).toEqual({
      outcome: "not-run",
      disposition: "denied",
      reason: "decompose-per-root",
    });
    const record = auditRecord(BOUND_SESSION_ID);
    expect(record).toMatchObject({
      denyReason: "decompose-per-root",
      rootAttribution: { rootRef: SESSION_ROOT_REF },
    });
    expect(record).not.toHaveProperty("targetPath");
    expect(JSON.stringify(record)).not.toContain(CALLER_ROOT_REF);
    expect(manager.calls).toBe(0);
  });

  it("rolls the reservation back when the root stops holding after admission", async () => {
    // The post-reservation re-bind is this route's time-of-check/time-of-use guard: the manifest can
    // change between admission and dispatch. It had no coverage, so neither did its rollback.
    const manager = new FakeManager();
    const authorityRef = registerAuthority(undefined, {
      budget: {
        maxRuntimeMs: 3_600_000,
        maxToolCalls: 1,
        maxPromptTokens: 10_000,
        maxPatchBytes: 65_536,
      },
    });
    // A real store with exactly one method overridden — a typed UiStore, not a coerced fragment, so
    // the manifest lookup this test steers still answers the interface the route actually calls.
    const backing = createInMemoryUiStore();
    let admitted = false;
    const store: UiStore = {
      ...backing,
      findWorkspaceManifestRecordByProject: (): WorkspaceManifestRecordRow | undefined =>
        admitted ? unparseableManifestRow() : undefined,
    };
    const request = { schemaVersion: "1", sessionId: SESSION_ID, kind: "typecheck", authorityRef };

    try {
      const denied = await handleEditorAgentVerificationRun(
        ctx(request),
        { ...deps(manager), store },
        {
          decide: (): EditorAgentActionPolicyDecision => {
            admitted = true;
            return { disposition: "allowed", effectClass: "execution", origin: "agent" };
          },
        },
      );
      const retry = await handleEditorAgentVerificationRun(ctx(request), deps(manager));

      expect(resultBody(denied)).toMatchObject({
        outcome: "not-run",
        disposition: "denied",
        reason: "root-binding-invalid",
      });
      // The one tool call the envelope grants must be back: without the rollback the retry below
      // would be refused for an exhausted budget rather than run.
      expect(resultBody(retry)).toMatchObject({ outcome: "completed" });
      expect(manager.calls).toBe(1);
    } finally {
      backing.close();
    }
  });

  it("denies and audits a request whose budget is gone by reservation time", async () => {
    // The admission decision and the budget charge are two separate reads of the envelope. This is
    // the window between them: policy says allowed, and the reservation still finds nothing left.
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

    await handleEditorAgentVerificationRun(ctx(request), deps(manager));
    const exhausted = await handleEditorAgentVerificationRun(ctx(request), deps(manager), {
      decide: (): EditorAgentActionPolicyDecision => ({
        disposition: "allowed",
        effectClass: "execution",
        origin: "agent",
      }),
    });

    expect(resultBody(exhausted)).toEqual({
      outcome: "not-run",
      disposition: "denied",
      reason: "authority-budget-exceeded",
    });
    expect(auditRecord(SESSION_ID)).toMatchObject({
      disposition: "denied",
      denyReason: "authority-budget-exceeded",
      outcome: "conflict",
    });
    expect(manager.calls).toBe(1);
  });

  it("fails closed when a boundary denial cannot be audited", async () => {
    const manager = new FakeManager();
    const authorityRef = registerAuthority();
    const result = await handleEditorAgentVerificationRun(
      ctx({
        schemaVersion: "1",
        sessionId: SESSION_ID,
        kind: "typecheck",
        authorityRef,
        rootBinding: callerRootBinding(),
      }),
      deps(manager),
      { audit: (): null => null },
    );
    expect(result).toMatchObject({
      status: 503,
      body: { error: { code: "AGENT_VERIFICATION_AUDIT_FAILED" } },
    });
    expect(manager.calls).toBe(0);
  });
});

// A stored manifest row whose payload cannot be parsed back into a valid manifest. The root resolver
// treats it as an unresolvable root (`root-binding-invalid`) rather than trusting the row's metadata.
function unparseableManifestRow(): WorkspaceManifestRecordRow {
  return {
    workspaceId: "workspace-1",
    schemaVersion: 1,
    manifestRef: "manifest-2624",
    revision: 3,
    manifestDigest: "e".repeat(64),
    recordJson: "{",
    updatedAt: 1,
    rootProjects: [],
  };
}

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

describe("verificationAuthorityDenyReason", () => {
  it("maps an expired authority to authority-expired", () => {
    expect(verificationAuthorityDenyReason("expired")).toBe("authority-expired");
  });

  it("maps an exhausted budget to authority-budget-exceeded", () => {
    expect(verificationAuthorityDenyReason("budget-exceeded")).toBe("authority-budget-exceeded");
  });

  it.each(["invalid", "revoked"] satisfies EditorAgentAuthorityFailureReason[])(
    "falls back to authority-invalid for %s",
    (reason) => {
      expect(verificationAuthorityDenyReason(reason)).toBe("authority-invalid");
    },
  );
});
