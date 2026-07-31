import { describe, expect, it } from "vitest";

import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";

import {
  createProductionAuxiliaryPorts,
  type ProductionAuxiliaryPortInput,
} from "./productionAuxiliaryPorts.js";
import type { CodingToolMutationGuard } from "./codingToolFacadePorts.js";
import type { CodingToolActionOf } from "./codingToolGovernedDelegate.js";
import type {
  AuxiliaryResearchScopeV1,
  CodingWorkbenchAuthorityEnvelope,
} from "@oscharko-dev/keiko-contracts";
import { createServerApprovedSkillCatalog } from "./skillCatalog.js";
import { createResearchGrantRegistry } from "./researchGrantRegistry.js";
import { createExplicitSkillInvocationTracker } from "./explicitSkillInvocation.js";

const AUTHORITY_EXPIRES_AT = "2026-07-20T01:00:00.000Z";

const PARENT_AUTHORITY: CodingWorkbenchAuthorityEnvelope = {
  schemaVersion: "1",
  runId: "run-2387",
  localUser: "local-operator",
  taskRefs: ["issue-2387"],
  workspace: {
    workspaceId: "workspace-2387",
    rootLabel: "keiko-workspace",
    rootDigest: "a".repeat(64),
  },
  branch: {
    baseRef: "dev",
    headRef: "issue/2387",
    allowDetachedHead: false,
    allowedPrefixes: ["issue/"],
  },
  requestedMode: "supervised-coding",
  deploymentCeiling: "supervised-coding",
  effectiveMode: "supervised-coding",
  runtimeSource: "keiko-sidecar",
  actionClasses: ["workspace-read"],
  connectorScopes: [],
  modelProfile: {
    profileId: "coding-safe-openai-compatible",
    source: "keiko-model-gateway",
    supportsStreaming: false,
    supportsToolCalling: true,
  },
  commandPolicy: {
    mode: "deny",
    allow: [],
    deny: [],
    maxCommandTimeoutMs: 1,
    requirePerCommandApproval: true,
  },
  networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
  gates: ["human-approval"],
  budget: { maxRuntimeMs: 120_000, maxToolCalls: 12, maxPromptTokens: 24_000, maxPatchBytes: 0 },
  expiresAt: AUTHORITY_EXPIRES_AT,
  approvalProofDigest: "b".repeat(64),
};

function response(): NormalizedResponse {
  return {
    modelId: "gpt-coding-safe",
    content: "Inspected",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "child-request",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

interface PortsOptions {
  readonly emit?: ((event: unknown) => void) | undefined;
  readonly researchGrantRegistry?:
    ProductionAuxiliaryPortInput["researchGrantRegistry"] | undefined;
  readonly readText?:
    ProductionAuxiliaryPortInput["secureWorkspaceTextRead"]["readText"] | undefined;
}

function ports(
  modelId: string,
  observed: string[] = [],
  options: PortsOptions = {},
): ReturnType<typeof createProductionAuxiliaryPorts> {
  const catalog = createServerApprovedSkillCatalog();
  return createProductionAuxiliaryPorts({
    authority: {
      state: () => ({
        schemaVersion: "1" as const,
        state: "running" as const,
        revision: 1,
        updatedAt: AUTHORITY_EXPIRES_AT,
        runId: "run-2387",
      }),
    },
    reservePromptTokens: () => true,
    taskId: "task-2387",
    runId: "run-2387",
    workspaceId: () => "workspace-2387",
    workspaceRoot: "/workspace",
    modelId,
    authorityExpiresAt: AUTHORITY_EXPIRES_AT,
    catalog,
    explicitSkills: createExplicitSkillInvocationTracker(catalog),
    modelPortFactory: (requested): ModelPort | undefined => {
      observed.push(requested);
      return { call: (): Promise<NormalizedResponse> => Promise.resolve(response()) };
    },
    secureWorkspaceTextRead: {
      readText:
        options.readText ??
        ((): ReturnType<ProductionAuxiliaryPortInput["secureWorkspaceTextRead"]["readText"]> =>
          Promise.resolve({ ok: true as const, text: '{"scripts":{"b":"1","a":"2"}}' })),
    },
    emit: options.emit ?? ((): void => undefined),
    ...(options.researchGrantRegistry === undefined
      ? {}
      : { researchGrantRegistry: options.researchGrantRegistry }),
  });
}

const LIVE_GUARD: CodingToolMutationGuard = {
  check: () => true,
  resolveParentAuthority: () => PARENT_AUTHORITY,
  chargeDelegatedRead: () => true,
};

function skillAction(skillId: string): CodingToolActionOf<"skill"> {
  return {
    action: "skill",
    actionId: "act-skill-1",
    idempotencyKey: "idem-skill-1",
    skillId,
  };
}

function childAction(): CodingToolActionOf<"child-agent"> {
  return {
    action: "child-agent",
    actionId: "act-child-1",
    idempotencyKey: "idem-child-1",
    objective: "Inspect the repository entry point",
    maxToolCalls: 2,
  };
}

describe("createProductionAuxiliaryPorts", () => {
  it("mounts the child-agent port when a provider model id is resolved", () => {
    expect(ports("gpt-coding-safe").childAgentAuthority).toBeDefined();
  });

  it("#2387: leaves the child-agent port unmounted when no coding-safe model resolved", () => {
    // An unmounted port makes the governed delegate answer "failed" for every child request. The
    // alternative — launching a child against a placeholder or a Keiko launch-profile identifier
    // such as "coding-safe-openai-compatible" — would fail on the child's first gateway call, on a
    // real installation only, because every test harness stubs the model port.
    const surface = ports("");

    expect(surface.childAgentAuthority).toBeUndefined();
    expect(surface.skillAuthority).toBeDefined();
  });

  it("always mounts the skill port, which needs no provider model", () => {
    expect(ports("").skillAuthority).toBeDefined();
  });

  it("runs an approved repository-analysis skill and audits the invocation", async () => {
    const events: unknown[] = [];
    const surface = ports("gpt-coding-safe", [], { emit: (e) => events.push(e) });

    const result = await surface.skillAuthority.execute(
      skillAction("skl_repo-structure-summary@1"),
      undefined,
      LIVE_GUARD,
    );

    expect(result).toMatchObject({ status: "completed" });
    expect(events).not.toHaveLength(0);
    // The audited event is content-free: it never carries the file text the skill read.
    expect(JSON.stringify(events)).not.toContain("scripts");
  });

  it("digests package scripts in codepoint order, independent of key order and host locale", async () => {
    // The digest must be identical on every host. `localeCompare()` without a fixed locale sorts by
    // the HOST locale — de-DE and sv-SE order "Ärger" differently — so the same package.json would
    // hash differently on differently-configured machines. Two runs whose script sets are equal but
    // written in a different order, including a non-ASCII key, must agree.
    const scripts = '{"scripts":{"Zebra":"1","apple":"2","Ärger":"3","_x":"4"}}';
    const reordered = '{"scripts":{"_x":"4","Ärger":"3","apple":"2","Zebra":"1"}}';

    const digestFor = async (text: string): Promise<string> => {
      const surface = ports("gpt-coding-safe", [], {
        readText: () => Promise.resolve({ ok: true as const, text }),
      });
      const result = await surface.skillAuthority.execute(
        skillAction("skl_repo-structure-summary@1"),
        undefined,
        LIVE_GUARD,
      );
      return JSON.stringify(result);
    };

    expect(await digestFor(scripts)).toBe(await digestFor(reordered));
  });

  it("denies a skill the catalog does not approve, and still audits the probe", async () => {
    const events: unknown[] = [];
    const surface = ports("gpt-coding-safe", [], { emit: (e) => events.push(e) });

    const result = await surface.skillAuthority.execute(
      skillAction("skl_not-approved@1"),
      undefined,
      LIVE_GUARD,
    );

    expect(result).toMatchObject({ status: "completed" });
    expect(events).not.toHaveLength(0);
  });

  it("reports the skill unavailable when the workspace read fails closed", async () => {
    const surface = ports("gpt-coding-safe", [], {
      readText: () => Promise.resolve({ ok: false as const, reason: "denied" as const }),
    });

    const result = await surface.skillAuthority.execute(
      skillAction("skl_repo-structure-summary@1"),
      undefined,
      LIVE_GUARD,
    );

    expect(result).toMatchObject({ status: "completed" });
  });

  it("stops a child agent when the parent authority is no longer resolvable", async () => {
    const surface = ports("gpt-coding-safe");
    const revoked: CodingToolMutationGuard = {
      check: () => true,
      resolveParentAuthority: () => undefined,
    };

    const result = await surface.childAgentAuthority?.execute(childAction(), undefined, revoked);

    expect(result).toMatchObject({ status: "completed" });
    expect(JSON.stringify(result)).toContain("authority-revoked");
  });

  it("runs a child agent through the orchestrator under a live parent authority", async () => {
    const events: unknown[] = [];
    const surface = ports("gpt-coding-safe", [], { emit: (e) => events.push(e) });

    const result = await surface.childAgentAuthority?.execute(childAction(), undefined, LIVE_GUARD);

    expect(result).toMatchObject({ status: "completed" });
    // Child lifecycle is surfaced content-free: the objective text never reaches an event.
    expect(JSON.stringify(events)).not.toContain("Inspect the repository entry point");
  });

  it("passes the run's live research scope to the child, content-free", async () => {
    // A child inherits the parent's grant as a SCOPE — grant id, domains, expiry and the bound
    // request-line digest — never the sanitized query text itself.
    const registry = createResearchGrantRegistry();
    registry.register(
      "run-2387",
      {
        grantId: "research-grant-1" as AuxiliaryResearchScopeV1["grantId"],
        domains: ["docs.example.org"],
        expiresAt: AUTHORITY_EXPIRES_AT,
        queryTextDigest: { outcome: "known", value: "c".repeat(64) },
      },
      "approved query text",
      "d".repeat(64),
      Date.parse("2026-07-20T00:30:00.000Z"),
    );
    const events: unknown[] = [];
    const surface = ports("gpt-coding-safe", [], {
      emit: (e) => events.push(e),
      researchGrantRegistry: registry,
    });

    const result = await surface.childAgentAuthority?.execute(childAction(), undefined, LIVE_GUARD);

    expect(result).toMatchObject({ status: "completed" });
    expect(JSON.stringify(events)).not.toContain("approved query text");
  });

  it("stops the child when the parent budget refuses its first delegated call", async () => {
    const surface = ports("gpt-coding-safe");
    const exhausted: CodingToolMutationGuard = {
      check: () => true,
      resolveParentAuthority: () => PARENT_AUTHORITY,
      chargeDelegatedRead: () => false,
    };

    const result = await surface.childAgentAuthority?.execute(childAction(), undefined, exhausted);

    expect(result).toMatchObject({ status: "completed" });
  });
});
