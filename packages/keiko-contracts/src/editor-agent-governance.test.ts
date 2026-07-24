import { describe, expect, it } from "vitest";
import {
  EDITOR_AGENT_ACTION_DENY_REASONS,
  EDITOR_AGENT_ACTION_DISPOSITIONS,
  EDITOR_AGENT_ACTION_EFFECT_CLASS,
  EDITOR_AGENT_ACTION_APPROVAL_RISK,
  EDITOR_AGENT_ACTION_REVIEW_REASONS,
  EDITOR_AGENT_AUDIT_SCHEMA_VERSION,
  EDITOR_AGENT_AUDIT_SUMMARY_MAX_CHARS,
  EDITOR_AGENT_DISPOSITION_BY_POLICY_EFFECT,
  EDITOR_AGENT_WORKBENCH_ACTION_CLASS,
  EDITOR_AGENT_WORKBENCH_RESOURCE_SCOPE,
  buildEditorAgentActionAuditRecord,
  classifyEditorAgentAction,
  composeEditorAgentActionPolicyDecision as composeDecision,
  editorAgentDispositionForPolicyEffect,
  isEditorAgentActionAuditRecord,
  isEditorAgentActionDisposition,
  isEditorAgentActionEffectClass,
  isMutatingEditorAgentAction,
  type EditorAgentActionAuditInput,
  type EditorAgentActionPolicyContext,
  type EditorAgentActionPolicyDecision,
  type EditorAgentAuthorityPolicy,
  editorAgentRootBindingDenyReason,
} from "./editor-agent-governance.js";
import type { EditorAgentActionType } from "./editor-agent.js";
import { CODING_WORKBENCH_MODES, resolveEffectiveCodingWorkbenchMode } from "./coding-workbench.js";

const ALL_ACTION_TYPES: readonly EditorAgentActionType[] = [
  "openFile",
  "focusTab",
  "moveTab",
  "splitPane",
  "setSelection",
  "format",
  "save",
  "applyTextEdits",
  "applyPatch",
  "applyChangeset",
  "navigateSymbol",
  "searchWorkspace",
  "requestVerification",
  "queryGit",
];

const CONTENT_MUTATIONS: readonly EditorAgentActionType[] = [
  "format",
  "save",
  "applyTextEdits",
  "applyPatch",
  "applyChangeset",
];

const NON_MUTATING: readonly EditorAgentActionType[] = [
  "openFile",
  "focusTab",
  "moveTab",
  "splitPane",
  "setSelection",
  "navigateSymbol",
  "searchWorkspace",
  "requestVerification",
  "queryGit",
];

function ctx(over: Partial<EditorAgentActionPolicyContext> = {}): EditorAgentActionPolicyContext {
  return { targetPath: "src/a.ts", targetSensitive: false, ...over };
}

function authority(
  mode: EditorAgentAuthorityPolicy["effectiveMode"],
  over: Partial<EditorAgentAuthorityPolicy> = {},
): EditorAgentAuthorityPolicy {
  return {
    requestedMode: mode,
    deploymentCeiling: mode,
    effectiveMode: mode,
    actionClasses: ["workspace-write", "delivery-substrate"],
    ...over,
  };
}

function composeEditorAgentActionPolicyDecision(
  decision: EditorAgentActionPolicyDecision,
  policy: EditorAgentAuthorityPolicy,
  risk: Parameters<typeof composeDecision>[2],
  workspaceTrust: Parameters<typeof composeDecision>[3] = "trusted",
): EditorAgentActionPolicyDecision {
  return composeDecision(decision, policy, risk, workspaceTrust);
}

const DISPOSITION_RESTRICTION = {
  allowed: 0,
  "review-required": 1,
  denied: 2,
} as const;

const MONOTONIC_BASELINES: readonly EditorAgentActionPolicyDecision[] = [
  classifyEditorAgentAction("openFile", ctx()),
  classifyEditorAgentAction("queryGit", ctx()),
  classifyEditorAgentAction("save", ctx()),
  classifyEditorAgentAction("requestVerification", ctx()),
  { disposition: "allowed", effectClass: "external-effect", origin: "agent" },
];

describe("effect-class taxonomy (Issue #1395 D1)", () => {
  it("assigns an effect class to every action type", () => {
    for (const type of ALL_ACTION_TYPES) {
      expect(isEditorAgentActionEffectClass(EDITOR_AGENT_ACTION_EFFECT_CLASS[type])).toBe(true);
    }
  });

  it("classifies all write actions as content-mutation", () => {
    for (const type of CONTENT_MUTATIONS) {
      expect(EDITOR_AGENT_ACTION_EFFECT_CLASS[type]).toBe("content-mutation");
    }
  });

  it("classifies pure navigation, layout, and repository-read actions correctly", () => {
    expect(EDITOR_AGENT_ACTION_EFFECT_CLASS.openFile).toBe("navigation");
    expect(EDITOR_AGENT_ACTION_EFFECT_CLASS.focusTab).toBe("navigation");
    expect(EDITOR_AGENT_ACTION_EFFECT_CLASS.setSelection).toBe("navigation");
    expect(EDITOR_AGENT_ACTION_EFFECT_CLASS.navigateSymbol).toBe("workspace-read");
    expect(EDITOR_AGENT_ACTION_EFFECT_CLASS.searchWorkspace).toBe("workspace-read");
    expect(EDITOR_AGENT_ACTION_EFFECT_CLASS.queryGit).toBe("workspace-read");
    expect(EDITOR_AGENT_ACTION_EFFECT_CLASS.moveTab).toBe("layout");
    expect(EDITOR_AGENT_ACTION_EFFECT_CLASS.splitPane).toBe("layout");
    expect(EDITOR_AGENT_ACTION_EFFECT_CLASS.requestVerification).toBe("execution");
  });

  it("marks exactly the mutating action set as mutating (AC1)", () => {
    for (const type of CONTENT_MUTATIONS) expect(isMutatingEditorAgentAction(type)).toBe(true);
    for (const type of NON_MUTATING) expect(isMutatingEditorAgentAction(type)).toBe(false);
  });

  it("gates server-resolved repository reads through workspace-read authority", () => {
    for (const type of ["navigateSymbol", "searchWorkspace"] as const) {
      const baseline = classifyEditorAgentAction(type, ctx());
      expect(baseline.disposition).toBe("allowed");
      // ADR-0138's monotonic matrix gates workspace-contained actions behind approval under
      // governed-assist; the supervised middle mode admits the repository-backed read directly.
      expect(
        composeEditorAgentActionPolicyDecision(
          baseline,
          authority("governed-assist", { actionClasses: ["workspace-read"] }),
          EDITOR_AGENT_ACTION_APPROVAL_RISK[type],
        ),
      ).toMatchObject({ disposition: "review-required", effectClass: "workspace-read" });
      expect(
        composeEditorAgentActionPolicyDecision(
          baseline,
          authority("supervised-coding", { actionClasses: ["workspace-read"] }),
          EDITOR_AGENT_ACTION_APPROVAL_RISK[type],
        ),
      ).toMatchObject({ disposition: "allowed", effectClass: "workspace-read" });
      expect(
        composeEditorAgentActionPolicyDecision(
          baseline,
          authority("governed-assist", { actionClasses: [] }),
          EDITOR_AGENT_ACTION_APPROVAL_RISK[type],
        ),
      ).toMatchObject({
        disposition: "denied",
        effectClass: "workspace-read",
        denyReason: "mode-policy-denied",
      });
    }
  });
});

describe("policy classifier (Issue #1395 AC2)", () => {
  it("allows every navigation and layout action", () => {
    for (const type of NON_MUTATING) {
      const decision = classifyEditorAgentAction(type, ctx());
      expect(decision.disposition).toBe("allowed");
      expect(decision.denyReason).toBeUndefined();
      expect(decision.reviewReason).toBeUndefined();
    }
  });

  it("allows a contained, non-sensitive content mutation before mode composition", () => {
    for (const type of CONTENT_MUTATIONS) {
      const decision = classifyEditorAgentAction(type, ctx());
      expect(decision.disposition).toBe("allowed");
      expect(decision.reviewReason).toBeUndefined();
      expect(decision.denyReason).toBeUndefined();
    }
  });

  it("denies a content mutation whose target escapes the workspace root", () => {
    const decision = classifyEditorAgentAction(
      "applyTextEdits",
      ctx({ targetPath: "../escape.ts" }),
    );
    expect(decision.disposition).toBe("denied");
    expect(decision.denyReason).toBe("workspace-boundary-escape");
  });

  it("denies a content mutation that targets a deny-listed (sensitive) path", () => {
    const decision = classifyEditorAgentAction("save", ctx({ targetSensitive: true }));
    expect(decision.disposition).toBe("denied");
    expect(decision.denyReason).toBe("denied-sensitive-path");
  });

  it("prefers the boundary-escape reason over sensitivity when both hold", () => {
    const decision = classifyEditorAgentAction(
      "applyPatch",
      ctx({ targetPath: "../../etc/passwd", targetSensitive: true }),
    );
    expect(decision.disposition).toBe("denied");
    expect(decision.denyReason).toBe("workspace-boundary-escape");
  });

  it("is deterministic: same inputs yield an equal decision (replay-safe)", () => {
    const a = classifyEditorAgentAction("applyTextEdits", ctx({ targetSensitive: true }));
    const b = classifyEditorAgentAction("applyTextEdits", ctx({ targetSensitive: true }));
    expect(a).toEqual(b);
  });

  it("carries a chat origin and defaults an omitted origin to agent", () => {
    expect(classifyEditorAgentAction("applyPatch", ctx()).origin).toBe("agent");
    expect(classifyEditorAgentAction("applyPatch", ctx({ origin: "chat" })).origin).toBe("chat");
  });

  it("allows a content mutation with no file target (null path) that is not sensitive", () => {
    const decision = classifyEditorAgentAction("save", ctx({ targetPath: null }));
    expect(decision.disposition).toBe("allowed");
  });
});

describe("Authority Envelope composition (Issue #2121)", () => {
  it("maps all effect classes onto the shared Workbench vocabulary", () => {
    expect(EDITOR_AGENT_WORKBENCH_ACTION_CLASS).toEqual({
      navigation: null,
      layout: null,
      "workspace-read": "workspace-read",
      "content-mutation": "workspace-write",
      "external-effect": "delivery-substrate",
      execution: "verification",
    });
    expect(EDITOR_AGENT_WORKBENCH_RESOURCE_SCOPE).toEqual({
      navigation: null,
      layout: null,
      "workspace-read": "workspace-contained",
      "content-mutation": "workspace-contained",
      "external-effect": "delivery",
      execution: "workspace-contained",
    });
  });

  it("assigns deterministic risk without a second risk taxonomy", () => {
    expect(EDITOR_AGENT_ACTION_APPROVAL_RISK.save).toBe("low");
    expect(EDITOR_AGENT_ACTION_APPROVAL_RISK.applyPatch).toBe("medium");
    expect(EDITOR_AGENT_ACTION_APPROVAL_RISK.applyChangeset).toBe("high");
  });

  it("requires approval for a contained save in Ask for approval and allows it above (#2384)", () => {
    const baseline = classifyEditorAgentAction("save", ctx());
    const governed = composeEditorAgentActionPolicyDecision(
      baseline,
      authority("governed-assist"),
      EDITOR_AGENT_ACTION_APPROVAL_RISK.save,
    );
    expect(governed.disposition).toBe("review-required");
    expect(governed.reviewReason).toBe("mode-approval-required");
    for (const mode of ["supervised-coding", "autonomous-delivery"] as const) {
      const decision = composeEditorAgentActionPolicyDecision(
        baseline,
        authority(mode),
        EDITOR_AGENT_ACTION_APPROVAL_RISK.save,
      );
      expect(decision.disposition).toBe("allowed");
      expect(decision.effectClass).toBe("content-mutation");
    }
  });

  it("requires approval for a high-risk contained changeset below Full access", () => {
    const baseline = classifyEditorAgentAction("applyChangeset", ctx());
    for (const mode of ["governed-assist", "supervised-coding"] as const) {
      const decision = composeEditorAgentActionPolicyDecision(
        baseline,
        authority(mode),
        EDITOR_AGENT_ACTION_APPROVAL_RISK.applyChangeset,
      );
      expect(decision.disposition).toBe("review-required");
      expect(decision.reviewReason).toBe("deterministic-risk-approval-required");
    }
    expect(
      composeEditorAgentActionPolicyDecision(baseline, authority("autonomous-delivery"), "high")
        .disposition,
    ).toBe("allowed");
  });

  it("keeps the baseline denial when the mode ceiling is more permissive", () => {
    const baseline = classifyEditorAgentAction("applyPatch", ctx({ targetSensitive: true }));
    const decision = composeEditorAgentActionPolicyDecision(
      baseline,
      authority("autonomous-delivery"),
      "medium",
    );
    expect(decision).toEqual(baseline);
    expect(decision.denyReason).toBe("denied-sensitive-path");
  });

  it("exempts pure navigation and layout and keeps external delivery review-required", () => {
    for (const type of ["openFile", "focusTab", "setSelection", "moveTab", "splitPane"] as const) {
      const baseline = classifyEditorAgentAction(type, ctx());
      expect(
        composeEditorAgentActionPolicyDecision(
          baseline,
          authority("supervised-coding"),
          "critical",
        ),
      ).toEqual(baseline);
    }
    const external: EditorAgentActionPolicyDecision = {
      disposition: "allowed",
      effectClass: "external-effect",
      origin: "agent",
    };
    for (const mode of CODING_WORKBENCH_MODES) {
      const decision = composeEditorAgentActionPolicyDecision(
        external,
        authority(mode),
        "critical",
      );
      expect(decision.disposition).toBe("review-required");
      expect(decision.reviewReason).toBe("delivery-human-approval-required");
    }
  });

  it("composes requested mode and deployment ceiling effects with stricter-wins", () => {
    const baseline = classifyEditorAgentAction("applyChangeset", ctx());
    const policy = authority("governed-assist", {
      requestedMode: "supervised-coding",
      deploymentCeiling: "governed-assist",
    });
    const decision = composeEditorAgentActionPolicyDecision(baseline, policy, "high");
    expect(decision.disposition).toBe("review-required");
    expect(decision.reviewReason).toBe("deterministic-risk-approval-required");
  });

  it("denies an action class omitted by the validated Authority Envelope", () => {
    const baseline = classifyEditorAgentAction("save", ctx());
    const decision = composeEditorAgentActionPolicyDecision(
      baseline,
      authority("autonomous-delivery", { actionClasses: ["workspace-read"] }),
      "low",
    );
    expect(decision.disposition).toBe("denied");
    expect(decision.denyReason).toBe("mode-policy-denied");
  });

  it("folds Restricted Mode into mutation and execution without widening reads", () => {
    const mutation = classifyEditorAgentAction("save", ctx());
    expect(
      composeEditorAgentActionPolicyDecision(
        mutation,
        authority("autonomous-delivery"),
        "low",
        "restricted",
      ),
    ).toMatchObject({
      disposition: "review-required",
      reviewReason: "workspace-restricted",
    });

    const execution = classifyEditorAgentAction("requestVerification", ctx());
    expect(
      composeEditorAgentActionPolicyDecision(
        execution,
        authority("autonomous-delivery", { actionClasses: ["verification"] }),
        "low",
        "restricted",
      ),
    ).toMatchObject({ disposition: "denied", denyReason: "workspace-restricted" });
    expect(
      composeDecision(
        execution,
        authority("autonomous-delivery", { actionClasses: ["verification"] }),
        "low",
      ),
    ).toMatchObject({ disposition: "denied", denyReason: "workspace-restricted" });

    const read = classifyEditorAgentAction("queryGit", ctx());
    expect(
      composeEditorAgentActionPolicyDecision(
        read,
        authority("autonomous-delivery", { actionClasses: ["workspace-read"] }),
        "low",
        "restricted",
      ),
    ).toMatchObject({ disposition: "allowed", effectClass: "workspace-read" });
  });

  it("never widens any effect for every mode, ceiling, and trust-level triple", () => {
    const trustLevels = ["trusted", "restricted", undefined] as const;
    for (const requestedMode of CODING_WORKBENCH_MODES) {
      for (const deploymentCeiling of CODING_WORKBENCH_MODES) {
        const policy = authority(
          resolveEffectiveCodingWorkbenchMode(requestedMode, deploymentCeiling),
          {
            requestedMode,
            deploymentCeiling,
            actionClasses: [
              "workspace-read",
              "workspace-write",
              "verification",
              "delivery-substrate",
            ],
          },
        );
        for (const baseline of MONOTONIC_BASELINES) {
          const trusted = composeDecision(baseline, policy, "low", "trusted");
          for (const workspaceTrust of trustLevels) {
            const actual = composeDecision(baseline, policy, "low", workspaceTrust);
            expect(DISPOSITION_RESTRICTION[actual.disposition]).toBeGreaterThanOrEqual(
              DISPOSITION_RESTRICTION[trusted.disposition],
            );
          }
        }
      }
    }
  });

  it("gates low-risk queryGit reads through workspace-read authority without mutation or delivery", () => {
    const baseline = classifyEditorAgentAction("queryGit", ctx());
    const granted = composeEditorAgentActionPolicyDecision(
      baseline,
      authority("autonomous-delivery", { actionClasses: ["workspace-read"] }),
      EDITOR_AGENT_ACTION_APPROVAL_RISK.queryGit,
    );
    expect(granted).toMatchObject({ disposition: "allowed", effectClass: "workspace-read" });
    expect(EDITOR_AGENT_ACTION_APPROVAL_RISK.queryGit).toBe("low");
    expect(isMutatingEditorAgentAction("queryGit")).toBe(false);

    const withheld = composeEditorAgentActionPolicyDecision(
      baseline,
      authority("autonomous-delivery", { actionClasses: [] }),
      EDITOR_AGENT_ACTION_APPROVAL_RISK.queryGit,
    );
    expect(withheld).toMatchObject({
      disposition: "denied",
      effectClass: "workspace-read",
      denyReason: "mode-policy-denied",
    });
  });

  it("denies queryGit reads for escaping and sensitive targets before envelope composition", () => {
    expect(
      classifyEditorAgentAction("queryGit", ctx({ targetPath: "../escape.ts" })),
    ).toMatchObject({
      disposition: "denied",
      effectClass: "workspace-read",
      denyReason: "workspace-boundary-escape",
    });
    expect(classifyEditorAgentAction("queryGit", ctx({ targetSensitive: true }))).toMatchObject({
      disposition: "denied",
      effectClass: "workspace-read",
      denyReason: "denied-sensitive-path",
    });
  });
});

describe("disposition and reason enums", () => {
  it("freezes the three-way disposition taxonomy", () => {
    expect([...EDITOR_AGENT_ACTION_DISPOSITIONS]).toEqual(["allowed", "review-required", "denied"]);
    for (const d of EDITOR_AGENT_ACTION_DISPOSITIONS) {
      expect(isEditorAgentActionDisposition(d)).toBe(true);
    }
    expect(isEditorAgentActionDisposition("maybe")).toBe(false);
    expect(isEditorAgentActionDisposition(null)).toBe(false);
  });

  it("freezes the deny and review reason taxonomies", () => {
    expect(EDITOR_AGENT_ACTION_DENY_REASONS).toContain("authority-missing");
    expect(EDITOR_AGENT_ACTION_DENY_REASONS).toContain("authority-invalid");
    expect(EDITOR_AGENT_ACTION_DENY_REASONS).toContain("authority-expired");
    expect(EDITOR_AGENT_ACTION_DENY_REASONS).toContain("authority-budget-exceeded");
    expect(EDITOR_AGENT_ACTION_DENY_REASONS).toContain("unsupported-action");
    expect(EDITOR_AGENT_ACTION_DENY_REASONS).toContain("secret-exfiltration");
    expect(EDITOR_AGENT_ACTION_DENY_REASONS).toContain("platform-restricted");
    expect(EDITOR_AGENT_ACTION_DENY_REASONS).toContain("mode-policy-denied");
    expect(EDITOR_AGENT_ACTION_REVIEW_REASONS).toContain("mode-approval-required");
    expect(EDITOR_AGENT_ACTION_REVIEW_REASONS).toContain("deterministic-risk-approval-required");
    expect(EDITOR_AGENT_ACTION_REVIEW_REASONS).toContain("delivery-human-approval-required");
  });

  it("maps the central policy effects onto the existing editor disposition vocabulary", () => {
    expect(EDITOR_AGENT_DISPOSITION_BY_POLICY_EFFECT).toEqual({
      allowed: "allowed",
      "approval-required": "review-required",
      denied: "denied",
    });
    expect(editorAgentDispositionForPolicyEffect("allowed")).toBe("allowed");
    expect(editorAgentDispositionForPolicyEffect("approval-required")).toBe("review-required");
    expect(editorAgentDispositionForPolicyEffect("denied")).toBe("denied");
  });
});

function auditInput(over: Partial<EditorAgentActionAuditInput> = {}): EditorAgentActionAuditInput {
  return {
    auditId: "audit-1",
    occurredAt: 1_700_000_000_000,
    sessionId: "session-1",
    actionId: "action-1",
    actionType: "applyTextEdits",
    decision: classifyEditorAgentAction("applyTextEdits", ctx()),
    outcome: "queued",
    ...over,
  };
}

describe("audit record builder (Issue #1395 AC1, AC3)", () => {
  it("builds a content-free record for a mutating action", () => {
    const record = buildEditorAgentActionAuditRecord(
      auditInput({ targetPath: "src/a.ts", editCount: 3 }),
    );
    expect(record.schemaVersion).toBe(EDITOR_AGENT_AUDIT_SCHEMA_VERSION);
    expect(record.actionType).toBe("applyTextEdits");
    expect(record.effectClass).toBe("content-mutation");
    expect(record.mutating).toBe(true);
    expect(record.disposition).toBe("allowed");
    expect(record.reviewReason).toBeUndefined();
    expect(record.outcome).toBe("queued");
    expect(record.origin).toBe("agent");
    expect(record.targetPath).toBe("src/a.ts");
    expect(record.editCount).toBe(3);
    expect(isEditorAgentActionAuditRecord(record)).toBe(true);
  });

  it("distinguishes chat actions while retaining bounded target metadata", () => {
    const record = buildEditorAgentActionAuditRecord(
      auditInput({
        decision: classifyEditorAgentAction("applyPatch", ctx({ origin: "chat" })),
        actionType: "applyPatch",
        targetPath: "src/private-name.ts",
        patchByteLength: 123,
      }),
    );
    const serialized = JSON.stringify(record);
    expect(record.origin).toBe("chat");
    expect(record.targetPath).toBe("src/private-name.ts");
    expect(record.patchByteLength).toBe(123);
    expect(serialized).not.toContain("newText");
  });

  it("records the deny reason and conflict code for a denied action", () => {
    const decision = classifyEditorAgentAction("save", ctx({ targetSensitive: true }));
    const record = buildEditorAgentActionAuditRecord(
      auditInput({
        actionType: "save",
        decision,
        outcome: "conflict",
        conflictCode: "OUT_OF_SCOPE",
      }),
    );
    expect(record.disposition).toBe("denied");
    expect(record.denyReason).toBe("denied-sensitive-path");
    expect(record.conflictCode).toBe("OUT_OF_SCOPE");
    expect(record.summary).toContain("deny=denied-sensitive-path");
  });

  it("omits optional fields that are not supplied", () => {
    const record = buildEditorAgentActionAuditRecord(auditInput());
    expect("conflictCode" in record).toBe(false);
    expect("failureCode" in record).toBe(false);
    expect("editCount" in record).toBe(false);
    expect("patchByteLength" in record).toBe(false);
  });

  it("bounds the summary length regardless of an oversized target path", () => {
    const longPath = `src/${"x".repeat(EDITOR_AGENT_AUDIT_SUMMARY_MAX_CHARS * 2)}.ts`;
    const record = buildEditorAgentActionAuditRecord(auditInput({ targetPath: longPath }));
    expect(record.summary.length).toBeLessThanOrEqual(EDITOR_AGENT_AUDIT_SUMMARY_MAX_CHARS);
  });

  it("never carries an edit body: the input type has no raw-content field (AC3)", () => {
    // The builder is handed only counts/enums/ids. There is no field on EditorAgentActionAuditInput
    // through which raw source text, edit `newText`, or a patch body could enter the record. The
    // serialized record therefore cannot contain a unique source fingerprint.
    const fingerprint = "SUPER_SECRET_SOURCE_abc123_DO_NOT_LEAK";
    const record = buildEditorAgentActionAuditRecord(auditInput({ patchByteLength: 4096 }));
    expect(JSON.stringify(record)).not.toContain(fingerprint);
    expect(record.patchByteLength).toBe(4096);
  });

  it("uses bounded basename/hash-only target metadata for queryGit", () => {
    const targetPathHash = "a".repeat(64);
    const record = buildEditorAgentActionAuditRecord({
      ...auditInput(),
      actionType: "queryGit",
      decision: classifyEditorAgentAction("queryGit", ctx()),
      targetPath: "src/private/repository-name.ts",
      targetBasename: "repository-name.ts",
      targetPathHash,
    });
    expect(record.targetBasename).toBe("repository-name.ts");
    expect(record.targetPathHash).toBe(targetPathHash);
    expect(record.targetPath).toBeUndefined();
    expect(record.summary).not.toContain("src/private");
    expect(isEditorAgentActionAuditRecord(record)).toBe(true);
  });
});

describe("audit record guard", () => {
  it("rejects a record with a missing identifier or oversized summary", () => {
    const valid = buildEditorAgentActionAuditRecord(auditInput({ targetPath: "src/a.ts" }));
    expect(isEditorAgentActionAuditRecord(valid)).toBe(true);
    expect(isEditorAgentActionAuditRecord({ ...valid, auditId: "" })).toBe(false);
    expect(
      isEditorAgentActionAuditRecord({
        ...valid,
        summary: "y".repeat(EDITOR_AGENT_AUDIT_SUMMARY_MAX_CHARS + 1),
      }),
    ).toBe(false);
    expect(isEditorAgentActionAuditRecord({ ...valid, disposition: "nope" })).toBe(false);
    expect(isEditorAgentActionAuditRecord({ ...valid, origin: "automation" })).toBe(false);
    expect(isEditorAgentActionAuditRecord({ ...valid, targetBasename: "x".repeat(256) })).toBe(
      false,
    );
    expect(isEditorAgentActionAuditRecord({ ...valid, targetPathHash: "not-a-sha256" })).toBe(
      false,
    );
    expect(isEditorAgentActionAuditRecord({ ...valid, targetBasename: "src/a.ts" })).toBe(false);
    expect(isEditorAgentActionAuditRecord({ ...valid, targetPathHash: "A".repeat(64) })).toBe(
      false,
    );
    expect(isEditorAgentActionAuditRecord({ ...valid, effectClass: "workspace-read" })).toBe(false);
    expect(
      isEditorAgentActionAuditRecord({
        ...valid,
        actionType: "queryGit",
        effectClass: "workspace-read",
        targetPath: "src/a.ts",
      }),
    ).toBe(false);
    expect(isEditorAgentActionAuditRecord(null)).toBe(false);
  });
});

describe("execution effect class + requestVerification (Issue #2210, ADR-0126 D4/D5)", () => {
  it("maps requestVerification to the execution effect class", () => {
    expect(EDITOR_AGENT_ACTION_EFFECT_CLASS.requestVerification).toBe("execution");
    expect(Object.keys(EDITOR_AGENT_ACTION_EFFECT_CLASS)).toContain("requestVerification");
    expect(Object.keys(EDITOR_AGENT_ACTION_APPROVAL_RISK)).toContain("requestVerification");
  });

  it("maps execution onto the existing verification / workspace-contained vocabulary (non-null)", () => {
    // Non-null in BOTH tables so compose gates it through the Authority Envelope rather than
    // short-circuiting it like navigation/layout — the invariant the agent-access child issue needs.
    expect(EDITOR_AGENT_WORKBENCH_ACTION_CLASS.execution).toBe("verification");
    expect(EDITOR_AGENT_WORKBENCH_RESOURCE_SCOPE.execution).toBe("workspace-contained");
    expect(EDITOR_AGENT_WORKBENCH_ACTION_CLASS.execution).not.toBeNull();
    expect(EDITOR_AGENT_WORKBENCH_RESOURCE_SCOPE.execution).not.toBeNull();
  });

  it("classifies requestVerification as low approval risk and non-mutating", () => {
    expect(EDITOR_AGENT_ACTION_APPROVAL_RISK.requestVerification).toBe("low");
    expect(isMutatingEditorAgentAction("requestVerification")).toBe(false);
  });

  it("baseline-allows a contained request and denies escape/sensitive targets", () => {
    expect(classifyEditorAgentAction("requestVerification", ctx()).disposition).toBe("allowed");
    const escape = classifyEditorAgentAction("requestVerification", ctx({ targetPath: "../x.ts" }));
    expect(escape.disposition).toBe("denied");
    expect(escape.denyReason).toBe("workspace-boundary-escape");
    const sensitive = classifyEditorAgentAction(
      "requestVerification",
      ctx({ targetSensitive: true }),
    );
    expect(sensitive.disposition).toBe("denied");
    expect(sensitive.denyReason).toBe("denied-sensitive-path");
  });

  it("gates an execution request through the Authority Envelope (stricter-wins)", () => {
    const baseline = classifyEditorAgentAction("requestVerification", ctx());
    const granted = composeEditorAgentActionPolicyDecision(
      baseline,
      authority("autonomous-delivery", { actionClasses: ["verification"] }),
      "low",
    );
    expect(granted.disposition).not.toBe("denied");
    // An envelope WITHOUT the verification action class denies it — never short-circuited to allowed.
    const withheld = composeEditorAgentActionPolicyDecision(
      baseline,
      authority("autonomous-delivery", { actionClasses: [] }),
      "low",
    );
    expect(withheld.disposition).toBe("denied");
    expect(withheld.denyReason).toBe("mode-policy-denied");
  });
});

describe("editorAgentRootBindingDenyReason", () => {
  const binding = (overrides: Partial<Record<string, unknown>> = {}): never =>
    ({
      workspaceId: "ws-a",
      manifestRef: "manifest-a",
      manifestRevision: 4,
      manifestDigest: "d".repeat(64),
      rootRef: "root-" + "a".repeat(40),
      rootIdentityDigest: "i".repeat(64),
      ...overrides,
    }) as never;

  it("resolves the presence matrix exactly", () => {
    expect(editorAgentRootBindingDenyReason(undefined, undefined, false)).toBeNull();
    expect(editorAgentRootBindingDenyReason(undefined, undefined, true)).toBe(
      "root-binding-required",
    );
    expect(editorAgentRootBindingDenyReason(binding(), undefined, true)).toBe(
      "root-binding-required",
    );
    expect(editorAgentRootBindingDenyReason(undefined, binding(), true)).toBe(
      "root-binding-required",
    );
    // Half-present without the explicit requirement is not a soft pass — it is invalid.
    expect(editorAgentRootBindingDenyReason(binding(), undefined, false)).toBe(
      "root-binding-invalid",
    );
    expect(editorAgentRootBindingDenyReason(undefined, binding(), false)).toBe(
      "root-binding-invalid",
    );
  });

  it("orders the divergence checks: decompose beats invalid beats equality drift", () => {
    expect(
      editorAgentRootBindingDenyReason(
        binding(),
        binding({ rootRef: "root-" + "b".repeat(40) }),
        true,
      ),
    ).toBe("decompose-per-root");
    expect(
      editorAgentRootBindingDenyReason(
        binding(),
        binding({ rootIdentityDigest: "x".repeat(64) }),
        true,
      ),
    ).toBe("root-binding-invalid");
    for (const drift of [
      { workspaceId: "ws-other" },
      { manifestRef: "manifest-other" },
      { manifestRevision: 9 },
      { manifestDigest: "e".repeat(64) },
    ]) {
      expect(
        editorAgentRootBindingDenyReason(binding(), binding(drift), true),
        JSON.stringify(drift),
      ).toBe("root-binding-invalid");
    }
    expect(editorAgentRootBindingDenyReason(binding(), binding(), true)).toBeNull();
  });
});
