// ADR-0182 D2 (Issue #4135, AC1): each of the four read-only layers of a review run is proven on its
// own. Every block disables the other three -- it composes only its own layer, with the other
// layers permissive or absent -- and shows this layer alone still refuses a write, shell, web and
// Git tool, while the review tools pass. Each block also proves failure-first: the same probe
// against the Coding Workbench's ordinary composition of that layer is NOT refused, so the test
// detects the layer's absence.

import { describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchRuntimeAuthorityEnvelope,
  CodingWorkbenchRuntimeAuthorityFacts,
} from "@oscharko-dev/keiko-contracts";
import { REVIEW_RUNTIME_TOOL_NAMES } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import { createBufferedServerLogSink } from "../../../../../tests/support/buffered-server-log.js";
import { createCodingToolAuthorityPort } from "../../coding-runtime/codingToolAuthorityPort.js";
import { createCodingToolFacade } from "../../coding-runtime/codingToolFacade.js";
import type { CodingToolActionRequest } from "../../coding-runtime/codingToolIpc.js";
import { createCodingToolInvocationRegistry } from "../../coding-runtime/codingToolInvocationRegistry.js";
import {
  createFixedOpenCodeV2Config,
  openCodeReviewPermissionRules,
} from "../../coding-runtime/opencodeLaunchProfile.js";
import { createGeneratedOpenCodeV2Plugins } from "../../coding-runtime/opencodeRuntimeAdapter.js";
import {
  hasExactOpenCodeVisibleToolContract,
  OPENCODE_MODEL_VISIBLE_TOOLS,
  OPENCODE_REVIEW_VISIBLE_TOOLS,
  openCodeReviewToolContractDigest,
  projectedGatewaySchema,
} from "../../coding-runtime/opencodeToolSchemas.js";
import {
  codingRuntimeActionClassesForMode,
  codingRuntimeCommandPolicyForMode,
  codingRuntimeConnectorScopesForMode,
  codingRuntimeNetworkPolicyForMode,
  reviewRuntimeAuthorityGrants,
  REVIEW_RUNTIME_EFFECTIVE_MODE,
} from "../../coding-runtime/runtimeAuthorityService.js";
import { defaultServerDiagnosticSink } from "../../diagnostics-log.js";
import { createCanonicalCatalogFacadeBridge } from "../../tool-catalog/catalogToolFacadeBridge.js";
import { reviewPluginSetIsExact } from "./selfCheck.js";

/** The tool names a generated governed-tools plugin registers, in source order. */
function registeredPluginToolNames(source: string): readonly string[] {
  return [...source.matchAll(/register_(\w+)\(editor\);/gu)].map((match) => match[1] ?? "");
}

const GEOMETRY = { contextWindowTokens: 32_768, maxInputTokens: 28_672, maxOutputTokens: 4_096 };

/** The OpenCode tools a review run must never reach: write, shell, web, Git, questions, agents. */
const DENIED_TOOLS = [
  "keiko_changeset_edit",
  "keiko_verification",
  "keiko_research_fetch",
  "keiko_skill",
  "keiko_skill_discover",
  "keiko_child_agent",
  "keiko_git_status",
  "keiko_git_stage",
  "keiko_git_commit",
  "keiko_git_push",
  "keiko_git_execute",
  "keiko_git_sync",
  "keiko_pull_request",
  "keiko_ci_status",
  "question",
  "execute",
  "bash",
  "edit",
  "write",
  "apply_patch",
  "webfetch",
  "websearch",
  "task",
  "skill",
] as const;

type Rule = Readonly<Record<string, string>>;

/** OpenCode's permission semantics: ordered rules, `*` matches any action, the last match wins. */
function permissionFor(rules: readonly Rule[], action: string): string | undefined {
  let effect: string | undefined;
  for (const rule of rules) {
    if (rule.action === "*" || rule.action === action) effect = rule.effect;
  }
  return effect;
}

describe("layer 1 -- the generated configuration denies everything but the four review tools", () => {
  const review = createFixedOpenCodeV2Config(GEOMETRY, undefined, "review");
  const rules = review.permissions as readonly Rule[];

  it("denies every write, shell, web, Git, question and agent tool by configuration alone", () => {
    for (const tool of DENIED_TOOLS) expect(permissionFor(rules, tool)).toBe("deny");
    for (const tool of REVIEW_RUNTIME_TOOL_NAMES) expect(permissionFor(rules, tool)).toBe("allow");
    expect(rules).toEqual(openCodeReviewPermissionRules());
  });

  it("gives the review agent the same rules, so no agent widens them", () => {
    const agents = review.agents as Readonly<Record<string, { readonly permissions: Rule[] }>>;
    const agentRules = agents["keiko-reviewer"]?.permissions ?? [];
    for (const tool of DENIED_TOOLS) {
      expect(permissionFor([...rules, ...agentRules], tool)).toBe("deny");
    }
  });

  it("failure-first: the Coding Workbench's governed configuration allows edits and questions", () => {
    const direct = createFixedOpenCodeV2Config(GEOMETRY, undefined, "direct");
    const directRules = direct.permissions as readonly Rule[];
    expect(permissionFor(directRules, "keiko_changeset_edit")).toBe("allow");
    expect(permissionFor(directRules, "question")).toBe("allow");
    expect(permissionFor(directRules, "keiko_git_push")).toBe("allow");
  });
});

describe("layer 2 -- the registered tool set is exactly the four review tools, pinned by digest", () => {
  interface Tool {
    readonly name: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  }
  const projected = (tools: readonly Tool[]): Tool[] =>
    tools.map(({ name, parameters }) => ({
      name,
      parameters: projectedGatewaySchema(name, parameters),
    }));

  it("registers exactly the four review tools in the generated plugin", () => {
    const plugins = createGeneratedOpenCodeV2Plugins("review");
    // The self-check admits these sources by their SHA-256 pins, and no other source.
    expect(reviewPluginSetIsExact(plugins)).toBe(true);
    expect(Object.keys(plugins).sort()).toEqual(["keiko_governed_tools", "keiko_native_context"]);
    expect(registeredPluginToolNames(plugins.keiko_governed_tools ?? "")).toEqual([
      "keiko_workspace_discover",
      "keiko_workspace_read",
      "keiko_repository_search",
      "keiko_review_report",
    ]);
  });

  it("refuses a provider request that carries any other tool, even with the review tools", () => {
    const exact = projected(OPENCODE_REVIEW_VISIBLE_TOOLS);
    expect(hasExactOpenCodeVisibleToolContract(exact, "review")).toBe(true);
    for (const extra of OPENCODE_MODEL_VISIBLE_TOOLS.filter(
      ({ name }) => !(REVIEW_RUNTIME_TOOL_NAMES as readonly string[]).includes(name),
    )) {
      const withExtra = [...exact, ...projected([extra])];
      expect(hasExactOpenCodeVisibleToolContract(withExtra, "review")).toBe(false);
    }
    const tampered = exact.map((tool) =>
      tool.name === "keiko_review_report"
        ? { ...tool, parameters: { ...tool.parameters, required: [] } }
        : tool,
    );
    expect(hasExactOpenCodeVisibleToolContract(tampered, "review")).toBe(false);
  });

  it("pins the review contract digest", () => {
    expect(openCodeReviewToolContractDigest()).toBe(REVIEW_CONTRACT_DIGEST);
  });

  it("failure-first: the Coding Workbench's tool set registers the edit, Git and web tools", () => {
    const names = registeredPluginToolNames(
      createGeneratedOpenCodeV2Plugins("direct").keiko_governed_tools ?? "",
    );
    expect(names).toEqual(expect.arrayContaining(["keiko_changeset_edit", "keiko_git_push"]));
    expect(names).not.toContain("keiko_review_report");
    expect(hasExactOpenCodeVisibleToolContract(projected(OPENCODE_REVIEW_VISIBLE_TOOLS))).toBe(
      false,
    );
  });
});

const DIGEST = "a".repeat(64);
const FACTS = {
  binding: {
    taskId: "task-1",
    projectId: "project-1",
    projectDigest: DIGEST,
    workspaceId: "workspace-1",
    workspaceRootDigest: DIGEST,
    branchRef: "keiko-review/x",
    branchHeadDigest: DIGEST,
  },
} as unknown as CodingWorkbenchRuntimeAuthorityFacts;

function authorityContext(): Parameters<typeof createCodingToolAuthorityPort>[1] {
  return () => ({
    adapterKind: "model-gateway-sidecar",
    liveFacts: FACTS,
    workspaceRoot: "/review/worktree",
    deploymentCeiling: "governed-assist",
    nowIso: "2026-10-30T09:00:00.000Z",
  });
}

function envelope(
  authority: Readonly<Record<string, unknown>>,
): CodingWorkbenchRuntimeAuthorityEnvelope {
  return { authority } as unknown as CodingWorkbenchRuntimeAuthorityEnvelope;
}

const identity = { actionId: "action-1", idempotencyKey: "key-1" } as const;
const EDIT_REQUEST: CodingToolActionRequest = {
  ...identity,
  action: "edit",
  changeset: {
    patch: "--- a/a\n+++ b/a\n@@\n-a\n+b\n",
    files: [{ file: "a", expectedContentHash: DIGEST }],
  },
};
const COMMAND_REQUEST: CodingToolActionRequest = {
  ...identity,
  action: "command",
  commandId: "test",
};
const EGRESS_REQUEST: CodingToolActionRequest = {
  ...identity,
  action: "egress",
  target: "https://example.invalid/",
};
const WRITE_SHELL_WEB_GIT: readonly CodingToolActionRequest[] = [
  EDIT_REQUEST,
  COMMAND_REQUEST,
  EGRESS_REQUEST,
  { ...identity, action: "git", operation: "write" },
  { ...identity, action: "git", operation: "stage", phase: "propose", paths: ["a"] },
  { ...identity, action: "delivery", intent: "push", phase: "propose" },
  { ...identity, action: "connector", scope: "source-control.write" },
  { ...identity, action: "verification", verifierId: "test" },
];
const REVIEW_REQUESTS: readonly CodingToolActionRequest[] = [
  { ...identity, action: "read", relativePath: "src/a.ts", startLine: 1, maxLines: 10 },
  { ...identity, action: "discover", query: "a", maxResults: 5 },
  { ...identity, action: "review-report", report: {} },
];

describe("layer 3 -- the review authority grants workspace-read only, checked on every call", () => {
  const reviewAuthority = envelope({
    effectiveMode: REVIEW_RUNTIME_EFFECTIVE_MODE,
    ...reviewRuntimeAuthorityGrants(),
  });

  function port(
    authority: CodingWorkbenchRuntimeAuthorityEnvelope,
  ): ReturnType<typeof createCodingToolAuthorityPort> {
    return createCodingToolAuthorityPort(
      {
        revalidateCapabilityForMutation: vi.fn(() => ({ ok: true as const, envelope: authority })),
        resolveCapabilityForDelegation: vi.fn(() => ({ ok: true as const, envelope: authority })),
      },
      authorityContext(),
    );
  }

  it("denies every write, shell, web and Git action with no facade or configuration involved", () => {
    const admission = port(reviewAuthority);
    for (const request of WRITE_SHELL_WEB_GIT) {
      expect(admission.admit("capability", request).ok, request.action).toBe(false);
    }
    for (const request of REVIEW_REQUESTS) {
      expect(admission.admit("capability", request).ok, request.action).toBe(true);
    }
  });

  it("failure-first: the ordinary Ask-for-approval coding authority admits an edit", () => {
    const coding = envelope({
      effectiveMode: "governed-assist",
      actionClasses: codingRuntimeActionClassesForMode("governed-assist", false),
      connectorScopes: codingRuntimeConnectorScopesForMode("governed-assist"),
      commandPolicy: codingRuntimeCommandPolicyForMode("governed-assist"),
      networkPolicy: codingRuntimeNetworkPolicyForMode("governed-assist", false),
    });
    expect(port(coding).admit("capability", EDIT_REQUEST).ok).toBe(true);
  });
});

describe("layer 4 -- the tool facade and the catalog bridge refuse every non-read action", () => {
  function permissiveFacade(runtimePurpose: "review" | undefined): {
    readonly facade: ReturnType<typeof createCodingToolFacade>;
    readonly delegated: string[];
    readonly log: ReturnType<typeof createBufferedServerLogSink>;
  } {
    const delegated: string[] = [];
    const log = createBufferedServerLogSink();
    const facade = createCodingToolFacade(
      {
        authority: {
          admit: (): { readonly ok: true; readonly mutationGuard: { check: () => boolean } } => ({
            ok: true,
            mutationGuard: { check: () => true },
          }),
        },
        delegate: {
          execute: (request): Promise<unknown> => {
            delegated.push(request.action);
            return Promise.resolve({ outcome: "completed" });
          },
        },
      },
      {
        ...(runtimePurpose === undefined ? {} : { runtimePurpose }),
        runtimePurposeLog: { sink: log, correlationId: () => "review-run-correlation-1" },
      },
    );
    return { facade, delegated, log };
  }

  const body = (request: CodingToolActionRequest): string => JSON.stringify(request);

  it("refuses write, shell, web and Git at the facade under a permissive authority", async () => {
    const { facade, delegated, log } = permissiveFacade("review");
    for (const request of WRITE_SHELL_WEB_GIT) {
      const result = await facade.execute({ body: body(request), capability: "capability" });
      expect(result.status, request.action).toBe("denied");
    }
    expect(delegated).toEqual([]);
    const refused = log.events.filter((event) => event.op === "review.run.action-refused");
    expect(refused).toHaveLength(WRITE_SHELL_WEB_GIT.length);
    expect(refused.every((event) => event.extra?.layer === "tool-facade")).toBe(true);
  });

  it("lets the three reads and the report through to the ordinary admission", async () => {
    const { facade, delegated } = permissiveFacade("review");
    for (const request of REVIEW_REQUESTS) {
      await facade.execute({ body: body(request), capability: "capability" });
    }
    expect(delegated).toEqual(["read", "discover", "review-report"]);
  });

  it("failure-first: without review authority the permissive facade delegates a command", async () => {
    const { facade, delegated } = permissiveFacade(undefined);
    await facade.execute({ body: body(COMMAND_REQUEST), capability: "capability" });
    expect(delegated).toEqual(["command"]);
  });

  function permissiveBridge(runtimePurpose: "review" | undefined): {
    readonly bridge: ReturnType<typeof createCanonicalCatalogFacadeBridge>;
    readonly log: ReturnType<typeof createBufferedServerLogSink>;
  } {
    const log = createBufferedServerLogSink();
    const bridge = createCanonicalCatalogFacadeBridge({
      authority: {
        admit: (): { readonly ok: true; readonly mutationGuard: { check: () => boolean } } => ({
          ok: true,
          mutationGuard: { check: () => true },
        }),
      },
      previewAuthority: () => ({ ok: true }),
      invocationRegistry: createCodingToolInvocationRegistry({ now: () => 0 }),
      context: () => ({
        runId: "run-1",
        correlationId: "a".repeat(36),
        workspaceRoot: "/workspace",
        workspaceIdentity: "workspace-1",
        workspaceRevision: "b".repeat(64),
        authorityExpiresAt: "2030-01-01T00:00:00.000Z",
        now: 0,
      }),
      elapsedNow: () => 0,
      logPort: { primary: log, diagnostics: defaultServerDiagnosticSink },
      approvalAvailable: false,
      ...(runtimePurpose === undefined ? {} : { runtimePurpose }),
    });
    return { bridge, log };
  }

  it("refuses every covered write, web and Git action at the catalog bridge on its own", async () => {
    const { bridge, log } = permissiveBridge("review");
    const run = vi.fn(() => Promise.resolve({ status: "completed" as const, evidence: [] }));
    const covered = WRITE_SHELL_WEB_GIT.filter((request) => bridge.covers(request));
    expect(covered.map((request) => request.action)).toEqual(
      expect.arrayContaining(["edit", "egress", "git", "delivery"]),
    );
    for (const request of covered) {
      const result = await bridge.execute(request, { body: body(request), capability: "c" }, run);
      expect(result.status, request.action).toBe("denied");
    }
    expect(run).not.toHaveBeenCalled();
    const refused = log.events.filter((event) => event.op === "review.run.action-refused");
    expect(refused.every((event) => event.extra?.layer === "catalog-bridge")).toBe(true);
    expect(refused).toHaveLength(covered.length);
  });

  it("failure-first: without review authority the bridge emits no refusal of its own", async () => {
    const { bridge, log } = permissiveBridge(undefined);
    const egress = EGRESS_REQUEST;
    const run = vi.fn(() => Promise.resolve({ status: "completed" as const, evidence: [] }));
    await bridge.execute(egress, { body: body(egress), capability: "c" }, run);
    expect(log.events.some((event) => event.op === "review.run.action-refused")).toBe(false);
  });
});

// The review profile's exact model-visible contract (four tools, their projected schemas). A change
// to any review tool's schema, or a fifth tool, changes this digest and must be reviewed.
const REVIEW_CONTRACT_DIGEST = "5a9e88af9dbf1e6a16f17d9e854cbedfdc471cedc72d85970bdfee216466a904";
