import { describe, expect, it, vi } from "vitest";

import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { GatewayCallRequest, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import {
  CHILD_WORKSPACE_READ_ALIAS,
  createToolInvocationNormalizer,
} from "@oscharko-dev/keiko-tool-catalog";

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
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

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
    profileId: "local-codex",
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
  budget: {
    maxRuntimeMs: 120_000,
    maxToolCalls: 12,
    maxPromptTokens: 24_000,
    maxPatchBytes: 32_768,
  },
  expiresAt: AUTHORITY_EXPIRES_AT,
  approvalProofDigest: "b".repeat(64),
};

function response(overrides: Partial<NormalizedResponse> = {}): NormalizedResponse {
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
    ...overrides,
  };
}

interface PortsOptions {
  readonly emit?: ((event: unknown) => void) | undefined;
  readonly researchGrantRegistry?:
    ProductionAuxiliaryPortInput["researchGrantRegistry"] | undefined;
  readonly readText?:
    ProductionAuxiliaryPortInput["secureWorkspaceTextRead"]["readText"] | undefined;
  readonly modelCall?: ((request: GatewayCallRequest) => Promise<NormalizedResponse>) | undefined;
  readonly resolveWorkspaceRootAccess?:
    ProductionAuxiliaryPortInput["resolveWorkspaceRootAccess"] | undefined;
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
    resolveWorkspaceRootAccess:
      options.resolveWorkspaceRootAccess ??
      ((): ReturnType<ProductionAuxiliaryPortInput["resolveWorkspaceRootAccess"]> => ({
        kind: "managed-task",
        canonicalRoot: "/workspace",
        fs: nodeWorkspaceFs,
        repositoryRoot: "/repository",
      })),
    modelId,
    authorityExpiresAt: AUTHORITY_EXPIRES_AT,
    catalog,
    explicitSkills: createExplicitSkillInvocationTracker(catalog),
    modelPortFactory: (requested): ModelPort | undefined => {
      observed.push(requested);
      return {
        call: options.modelCall ?? ((): Promise<NormalizedResponse> => Promise.resolve(response())),
      };
    },
    secureWorkspaceTextRead: {
      readText:
        options.readText ??
        ((): ReturnType<ProductionAuxiliaryPortInput["secureWorkspaceTextRead"]["readText"]> =>
          Promise.resolve({ ok: true as const, text: '{"scripts":{"b":"1","a":"2"}}' })),
    },
    emit: options.emit ?? ((): void => undefined),
    activityLog: { write: (): void => undefined },
    ...(options.researchGrantRegistry === undefined
      ? {}
      : { researchGrantRegistry: options.researchGrantRegistry }),
  });
}

// Binds the call to the harness's advertised catalog exactly the way a real provider adapter now
// must (mirrors packages/keiko-harness/src/_support.ts's scriptedModel) -- the mandatory catalog
// dispatch path (catalog-runtime.ts) rejects a toolCall with no bound `invocation`.
function toolThenFinish(
  name: string,
  args: Record<string, unknown>,
): (request: GatewayCallRequest) => Promise<NormalizedResponse> {
  let turn = 0;
  return (request): Promise<NormalizedResponse> => {
    turn += 1;
    if (turn !== 1) return Promise.resolve(response());
    const invocation =
      request.toolCatalog === undefined
        ? undefined
        : createToolInvocationNormalizer({
            catalog: request.toolCatalog.catalog,
            projection: request.toolCatalog.projection,
            offered: request.toolCatalog.offered,
          }).bindAlias(name, args, 0);
    return Promise.resolve(
      response({
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: `call-${String(turn)}`,
            name,
            arguments: args,
            ...(invocation === undefined ? {} : { invocation }),
          },
        ],
      }),
    );
  };
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

  it("re-proves the exact managed workspace before and after a skill read", async () => {
    const readText = vi.fn(() => Promise.resolve({ ok: true as const, text: '{"scripts":{}}' }));
    const resolveWorkspaceRootAccess = vi.fn(() => ({
      kind: "managed-task" as const,
      canonicalRoot: "/workspace",
      fs: nodeWorkspaceFs,
      repositoryRoot: "/repository",
    }));
    const surface = ports("gpt-coding-safe", [], { readText, resolveWorkspaceRootAccess });

    const result = await surface.skillAuthority.execute(
      skillAction("skl_repo-structure-summary@1"),
      undefined,
      LIVE_GUARD,
    );

    expect(result).toMatchObject({ status: "completed" });
    expect(readText).toHaveBeenCalledOnce();
    expect(resolveWorkspaceRootAccess).toHaveBeenCalledTimes(2);
  });

  it.each(["revoked", "replaced"] as const)(
    "fails a skill read closed when managed workspace authority is %s after the effect",
    async (outcome) => {
      let proofCount = 0;
      const readText = vi.fn(() =>
        Promise.resolve({ ok: true as const, text: '{"scripts":{"sentinel":"secret"}}' }),
      );
      const resolveWorkspaceRootAccess = vi.fn(() => {
        proofCount += 1;
        if (proofCount === 1) {
          return {
            kind: "managed-task" as const,
            canonicalRoot: "/workspace",
            fs: nodeWorkspaceFs,
            repositoryRoot: "/repository",
          };
        }
        return outcome === "revoked"
          ? undefined
          : {
              kind: "managed-task" as const,
              canonicalRoot: "/workspace-replacement",
              fs: nodeWorkspaceFs,
              repositoryRoot: "/repository",
            };
      });
      const surface = ports("gpt-coding-safe", [], { readText, resolveWorkspaceRootAccess });

      const result = await surface.skillAuthority.execute(
        skillAction("skl_repo-structure-summary@1"),
        undefined,
        LIVE_GUARD,
      );

      expect(readText).toHaveBeenCalledOnce();
      expect(resolveWorkspaceRootAccess).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(result)).toContain("skill-source-unavailable");
      expect(JSON.stringify(result)).not.toContain("sentinel");
    },
  );

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

  // #3407 repair: the mandatory catalog dispatch path rejects a tool call outside the child's
  // one-tool profile before executeRead ever runs (invocation cannot bind), so
  // productionReadOnlyChildRunner's session ends "failed" and throws "child-session-failed"
  // instead of the pre-catalog graceful DENIED path. This throw was never routed through the
  // orchestrator's own gate, so it never latches a governance terminal -- it hits the
  // orchestrator's PRE-EXISTING, already-pinned "bounded runner throws" contract
  // (readOnlyChildOrchestrator.test.ts: "fails closed to unavailable when the bounded runner
  // throws"), which classifies ANY unhandled runner fault as `unavailable`/`child-runner-error`.
  // This is the real, production-wired consequence one layer above productionReadOnlyChildRunner
  // for a hostile/fabricated tool call: it is a genuine reclassification from the pre-catalog
  // `accepted` (childResultCount 0) outcome, and it is INTENTIONAL -- an anomalous call outside
  // the child's declared one-tool surface is a runner-contract violation, not a normal negative
  // read result, so routing it into the orchestrator's existing runner-fault bucket is correct.
  // This test proves and pins that end-to-end mapping through the actual production wiring
  // (createProductionAuxiliaryPorts -> createReadOnlyChildOrchestrator +
  // createProductionReadOnlyChildRunner), not just the runner's own unit test.
  it("reports the child agent unavailable, not a silent zero-result accept, when the model calls a tool it was never given", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-20T00:30:00.000Z"));
    let reads = 0;
    const surface = ports("gpt-coding-safe", [], {
      modelCall: toolThenFinish("write_file", { relativePath: "src/index.ts", text: "mutated" }),
      readText: (): ReturnType<
        ProductionAuxiliaryPortInput["secureWorkspaceTextRead"]["readText"]
      > => {
        reads += 1;
        return Promise.resolve({ ok: true as const, text: "unreachable" });
      },
    });

    try {
      const result = await surface.childAgentAuthority?.execute(
        childAction(),
        undefined,
        LIVE_GUARD,
      );

      expect(reads).toBe(0);
      expect(result).toMatchObject({
        status: "completed",
        auxiliary: { status: "unavailable", reasonCode: "child-runner-error" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a child read closed when managed workspace authority is revoked after the effect", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-20T00:30:00.000Z"));
    let proofCount = 0;
    const readText = vi.fn(() =>
      Promise.resolve({ ok: true as const, text: "sentinel-child-text" }),
    );
    const resolveWorkspaceRootAccess = vi.fn(() => {
      proofCount += 1;
      return proofCount === 1
        ? {
            kind: "managed-task" as const,
            canonicalRoot: "/workspace",
            fs: nodeWorkspaceFs,
            repositoryRoot: "/repository",
          }
        : undefined;
    });
    const modelCall = vi.fn(
      toolThenFinish(CHILD_WORKSPACE_READ_ALIAS, { relativePath: "src/index.ts" }),
    );
    const surface = ports("gpt-coding-safe", [], {
      readText,
      resolveWorkspaceRootAccess,
      modelCall,
    });

    try {
      const result = await surface.childAgentAuthority?.execute(
        childAction(),
        undefined,
        LIVE_GUARD,
      );

      expect(modelCall).toHaveBeenCalledTimes(2);
      expect(resolveWorkspaceRootAccess).toHaveBeenCalledTimes(2);
      expect(readText).toHaveBeenCalledOnce();
      expect(JSON.stringify(result)).not.toContain("sentinel-child-text");
      expect(result).toMatchObject({
        auxiliary: { childResultCount: { outcome: "known", value: 0 } },
      });
    } finally {
      vi.useRealTimers();
    }
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
