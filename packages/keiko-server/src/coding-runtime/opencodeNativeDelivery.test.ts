import { createHash, webcrypto } from "node:crypto";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_NATIVE_EXACT_CONTENT_TOOLS,
  isGatewayNativeToolAdvertisement,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import { opencodeRegistrationSet } from "@oscharko-dev/keiko-tool-catalog";

import { mintProposalId } from "../gitDelivery/proposalId.js";
import { CODING_TOOL_MAX_BODY_BYTES, parseCodingToolRequest } from "./codingToolIpc.js";
import { OPENCODE_NATIVE_PROFILE_CONTEXT_ADDENDUM } from "./opencodeNativeContext.js";
import {
  OPENCODE_NATIVE_DELIVERY_PLUGIN_FILE,
  OPENCODE_NATIVE_DELIVERY_PLUGIN_ID,
  OPENCODE_NATIVE_DELIVERY_REFUSAL_MESSAGE,
  OPENCODE_NATIVE_DELIVERY_TOOL_NAMES,
  isOpenCodeNativeDeliveryToolName,
} from "./opencodeNativeDeliveryTools.js";
import { decideOpenCodeNativePolicy } from "./opencodeNativePolicy.js";
import { OPENCODE_NATIVE_TOOL_NAMES } from "./opencodeNativeTools.js";
import { createGeneratedOpenCodeV2Plugins } from "./opencodeRuntimeAdapter.js";
import {
  OPENCODE_MODEL_VISIBLE_TOOLS,
  OPENCODE_NATIVE_DELIVERY_TOOL_SOURCE_DEFINITIONS,
  OPENCODE_TOOL_SOURCE_DEFINITIONS,
  createOpenCodeNativeToolAdvertisement,
  hasExactOpenCodeVisibleToolContract,
  projectedGatewaySchema,
} from "./opencodeToolSchemas.js";

/**
 * Git delivery for native runs (#3897, T12/B1): the native profile registers exactly Keiko's
 * delivery tools through a generated plugin that is the mapped profiles' own tool source, so a
 * native call reaches the same tool facade with the same wire body, bounds and approvals.
 */

const EXPECTED_DELIVERY_TOOLS = [
  "keiko_ci_status",
  "keiko_git_branch",
  "keiko_git_commit",
  "keiko_git_diff",
  "keiko_git_execute",
  "keiko_git_push",
  "keiko_git_stage",
  "keiko_git_status",
  "keiko_git_sync",
  "keiko_pull_request",
  "keiko_verification",
];

interface ToolContext {
  readonly sessionID: string;
  readonly id: string;
  readonly agent: string;
  readonly messageID: string;
}

interface GeneratedTool {
  readonly name: string;
  readonly description: string;
  readonly input: unknown;
  readonly options: { readonly permission?: string; readonly codemode?: boolean };
  readonly execute: (
    input: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<{ readonly content: string; readonly output?: unknown }>;
}

/** A provider of the runtime's websearch service, as the producer's plugin API registers it. */
interface WebSearchProvider {
  readonly id: string;
  readonly name: string;
  readonly execute: (
    input: unknown,
    options: { readonly signal?: AbortSignal },
  ) => Promise<unknown>;
}

interface WebSearchEditor {
  readonly add: (provider: WebSearchProvider) => void;
  readonly default: { readonly set: (id: string) => void };
}

interface GeneratedPlugin {
  readonly id: string;
  readonly setup: (context: {
    readonly tool: {
      readonly hook: (name: string, callback: unknown) => Promise<unknown>;
      readonly transform: (
        callback: (editor: { readonly add: (tool: GeneratedTool) => void }) => void,
      ) => Promise<unknown>;
    };
    readonly websearch?: {
      readonly transform: (callback: (editor: WebSearchEditor) => void) => Promise<unknown>;
    };
  }) => Promise<unknown>;
}

interface FetchCall {
  readonly url: string;
  readonly method: unknown;
  readonly redirect: unknown;
  readonly headers: unknown;
  readonly body: Record<string, unknown>;
}

interface Loaded {
  readonly pluginId: string;
  readonly tools: Map<string, GeneratedTool>;
  readonly hooks: string[];
  readonly fetches: FetchCall[];
  /** The delay of every timer the plugin armed: the client-side deadline of each call. */
  readonly delays: number[];
  /** What the producer does when it disposes the plugin. */
  readonly dispose: () => void;
  /** The websearch providers the plugin registered, and the default it selected. */
  readonly webSearch: { readonly providers: WebSearchProvider[]; selected?: string };
}

const CONTEXT: ToolContext = {
  sessionID: "ses_native_delivery",
  id: "call_native_delivery",
  agent: "build",
  messageID: "msg_native_delivery",
};

const FACADE_RESULT = {
  status: "completed",
  evidence: [{ kind: "governed-delegate", code: "completed" }],
};

/** Runs a generated plugin source the way the producer loads it, against a recording fetch. */
async function load(
  profile: "direct" | "native",
  mode: string,
  answer: unknown = FACADE_RESULT,
): Promise<Loaded> {
  const sources = createGeneratedOpenCodeV2Plugins(profile);
  const source =
    profile === "native"
      ? sources[OPENCODE_NATIVE_DELIVERY_PLUGIN_FILE]
      : sources.keiko_governed_tools;
  if (source === undefined) throw new Error("generated tool plugin missing");
  const tools = new Map<string, GeneratedTool>();
  const hooks: string[] = [];
  const fetches: FetchCall[] = [];
  const delays: number[] = [];
  const plugin = new Script(
    `${source.replace("export default", "const generated =")}\ngenerated;`,
  ).runInNewContext({
    process: {
      env: {
        KEIKO_CODING_MODE: mode,
        KEIKO_CODING_RUN_ID: "run-native-delivery",
        KEIKO_TOOL_FACADE_URL: "http://127.0.0.1/fixture",
        KEIKO_TOOL_FACADE_CAPABILITY: "fixture-capability",
      },
    },
    crypto: webcrypto,
    fetch: (url: string, init: Record<string, unknown>): Promise<Response> => {
      fetches.push({
        url,
        method: init.method,
        redirect: init.redirect,
        headers: init.headers,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
    },
    AbortController,
    AbortSignal,
    Array,
    String,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    setTimeout: (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
      delays.push(delay);
      return setTimeout(callback, delay);
    },
    clearTimeout,
  }) as GeneratedPlugin;
  const webSearch: Loaded["webSearch"] = { providers: [] };
  const cleanup = await plugin.setup({
    websearch: {
      transform: (callback): Promise<unknown> => {
        callback({
          add: (provider): void => {
            webSearch.providers.push(provider);
          },
          default: {
            set: (id): void => {
              webSearch.selected = id;
            },
          },
        });
        return Promise.resolve();
      },
    },
    tool: {
      hook: (name): Promise<unknown> => {
        hooks.push(name);
        return Promise.resolve({ dispose: (): void => undefined });
      },
      transform: (callback): Promise<unknown> => {
        callback({
          add: (tool): void => {
            if (tools.has(tool.name)) throw new Error("duplicate-tool");
            tools.set(tool.name, tool);
          },
        });
        return Promise.resolve();
      },
    },
  });
  return {
    pluginId: plugin.id,
    tools,
    hooks,
    fetches,
    delays,
    dispose: (): void => {
      if (typeof cleanup === "function") (cleanup as () => void)();
    },
    webSearch,
  };
}

function toolOf(loaded: Loaded, name: string): GeneratedTool {
  const tool = loaded.tools.get(name);
  if (tool === undefined) throw new Error(`generated tool missing: ${name}`);
  return tool;
}

/** One valid argument set per delivery tool. */
const ARGUMENTS: Readonly<Record<string, Record<string, unknown>>> = {
  keiko_git_status: {},
  keiko_git_diff: { scope: "working-tree", paths: ["src/a.ts"] },
  keiko_git_stage: { paths: ["src/a.ts"], unstage: false },
  keiko_verification: { verifierId: "typecheck", targetPath: "" },
  keiko_git_commit: { message: "feat: add a" },
  keiko_git_push: {},
  keiko_pull_request: { title: "feat: add a" },
  keiko_git_execute: { kind: "commit", proposalId: mintProposalId("commit") },
  keiko_git_sync: { pull: false },
  keiko_git_branch: { name: "feature/x" },
  keiko_ci_status: { forceFresh: false },
};

describe("the native delivery tool set", () => {
  it("is exactly the Git delivery tools plus the verification that records commit proof", () => {
    expect([...OPENCODE_NATIVE_DELIVERY_TOOL_NAMES].sort()).toEqual(EXPECTED_DELIVERY_TOOLS);
    expect(Object.isFrozen(OPENCODE_NATIVE_DELIVERY_TOOL_NAMES)).toBe(true);
    for (const name of EXPECTED_DELIVERY_TOOLS)
      expect(isOpenCodeNativeDeliveryToolName(name)).toBe(true);
    for (const other of [
      "keiko_workspace_read",
      "keiko_changeset_edit",
      "read",
      "shell",
      7,
      undefined,
    ])
      expect(isOpenCodeNativeDeliveryToolName(other)).toBe(false);
  });

  it("is a subset of the mapped definitions, so no delivery tool is defined twice", () => {
    const mapped = new Map(OPENCODE_TOOL_SOURCE_DEFINITIONS.map((tool) => [tool.name, tool]));
    expect(
      OPENCODE_NATIVE_DELIVERY_TOOL_SOURCE_DEFINITIONS.map((tool) => tool.name).sort(),
    ).toEqual(EXPECTED_DELIVERY_TOOLS);
    for (const tool of OPENCODE_NATIVE_DELIVERY_TOOL_SOURCE_DEFINITIONS)
      expect(mapped.get(tool.name)).toBe(tool);
  });

  it("holds every Git action of the mapped definitions, and no other kind of tool but verification", () => {
    for (const tool of OPENCODE_TOOL_SOURCE_DEFINITIONS) {
      const delivery = isOpenCodeNativeDeliveryToolName(tool.name);
      if (tool.action.startsWith("git-")) expect(delivery, tool.name).toBe(true);
      else expect(delivery, tool.name).toBe(tool.action === "verification");
    }
  });

  it("never shadows one of the producer's own tools", () => {
    for (const name of OPENCODE_NATIVE_DELIVERY_TOOL_NAMES)
      expect(OPENCODE_NATIVE_TOOL_NAMES).not.toContain(name);
  });
});

describe("the generated native plugins", () => {
  it("add the delivery plugin beside the policy and context plugins, and nothing else", () => {
    expect(Object.keys(createGeneratedOpenCodeV2Plugins("native")).sort()).toEqual([
      "keiko_native_context",
      OPENCODE_NATIVE_DELIVERY_PLUGIN_FILE,
      "keiko_native_policy",
    ]);
    expect(Object.keys(createGeneratedOpenCodeV2Plugins("direct")).sort()).toEqual([
      "keiko_governed_tools",
      "keiko_native_context",
    ]);
  });

  it("register exactly the delivery tools, with no tool hook, and claim their own plugin id", async () => {
    const native = await load("native", "autonomous-delivery");
    expect(native.pluginId).toBe(OPENCODE_NATIVE_DELIVERY_PLUGIN_ID);
    expect([...native.tools.keys()].sort()).toEqual(EXPECTED_DELIVERY_TOOLS);
    // A native run's delivery calls are top-level; the policy plugin alone governs `execute`.
    expect(native.hooks).toEqual([]);
    const mapped = await load("direct", "autonomous-delivery");
    expect(mapped.pluginId).toBe("keiko.governed-tools");
    expect(mapped.tools.size).toBe(OPENCODE_TOOL_SOURCE_DEFINITIONS.length);
    expect(mapped.hooks).toEqual(["execute.before", "execute.after"]);
  });

  it("keep every delivery tool out of Code Mode programs", async () => {
    const native = await load("native", "autonomous-delivery");
    for (const tool of native.tools.values()) {
      expect(tool.options).toEqual({ permission: tool.name, codemode: false });
    }
  });

  it("register the mapped profile's own definition of each delivery tool", async () => {
    const native = await load("native", "autonomous-delivery");
    const mapped = await load("direct", "autonomous-delivery");
    for (const name of EXPECTED_DELIVERY_TOOLS) {
      const [a, b] = [toolOf(native, name), toolOf(mapped, name)];
      expect(a.description, name).toBe(b.description);
      expect(a.input, name).toEqual(b.input);
      expect(a.options, name).toEqual(b.options);
    }
  });

  it.each(EXPECTED_DELIVERY_TOOLS)(
    "call the tool facade for %s exactly as the mapped tool does: same request, bounds and deadline",
    async (name) => {
      const args = ARGUMENTS[name] ?? {};
      const native = await load("native", "autonomous-delivery");
      const mapped = await load("direct", "autonomous-delivery");
      const [fromNative, fromMapped] = [
        await toolOf(native, name).execute({ ...args }, CONTEXT),
        await toolOf(mapped, name).execute({ ...args }, CONTEXT),
      ];
      expect(native.fetches).toEqual(mapped.fetches);
      expect(native.fetches).toHaveLength(1);
      expect(native.fetches[0]).toMatchObject({
        url: "http://127.0.0.1/fixture",
        method: "POST",
        redirect: "manual",
        headers: { Authorization: "Bearer fixture-capability" },
      });
      expect(native.delays).toEqual(mapped.delays);
      expect(native.delays[0]).toBeGreaterThan(0);
      expect(fromNative).toEqual(fromMapped);
      expect(fromNative.output).toEqual(FACADE_RESULT);
    },
  );

  it.each([
    ["keiko_git_status", {}, "git"],
    ["keiko_git_diff", ARGUMENTS.keiko_git_diff, "git"],
    ["keiko_git_stage", ARGUMENTS.keiko_git_stage, "git"],
    ["keiko_git_stage", { paths: ["src/a.ts"], unstage: true }, "git"],
    ["keiko_ci_status", ARGUMENTS.keiko_ci_status, "git"],
    ["keiko_git_sync", { pull: false }, "git"],
    ["keiko_git_sync", { pull: true }, "git"],
    ["keiko_git_branch", { name: "feature/x" }, "git"],
    ["keiko_verification", ARGUMENTS.keiko_verification, "verification"],
    ["keiko_git_commit", ARGUMENTS.keiko_git_commit, "delivery"],
    ["keiko_git_push", {}, "delivery"],
    ["keiko_pull_request", ARGUMENTS.keiko_pull_request, "delivery"],
    ["keiko_git_execute", ARGUMENTS.keiko_git_execute, "delivery"],
    ["keiko_git_execute", { kind: "stage", proposalId: mintProposalId("stage") }, "git"],
    ["keiko_git_execute", { kind: "unstage", proposalId: mintProposalId("unstage") }, "git"],
    ["keiko_git_execute", { kind: "push", proposalId: mintProposalId("delivery") }, "delivery"],
  ] as const)(
    "send %s as a request the facade's own parser accepts (%s -> %s)",
    async (name, args, action) => {
      const native = await load("native", "autonomous-delivery");
      await toolOf(native, name).execute({ ...args }, CONTEXT);
      const body = native.fetches[0]?.body;
      expect(body).toBeDefined();
      const parsed = parseCodingToolRequest(JSON.stringify(body), CODING_TOOL_MAX_BODY_BYTES);
      expect(parsed?.action).toBe(action);
      expect(body?.actionId).toBe("ses_native_delivery:call_native_delivery");
      expect(body?.idempotencyKey).toBe(body?.actionId);
    },
  );

  // #3902 AC2: unstaging is keiko_git_stage with `unstage: true`; the wire names the operation and
  // never carries the flag, which the facade's exact-key parser would refuse.
  it("propose staging and unstaging and redeem both with the wire fields the facade expects", async () => {
    const native = await load("native", "autonomous-delivery");
    await toolOf(native, "keiko_git_stage").execute(
      { paths: ["src/a.ts"], unstage: false },
      CONTEXT,
    );
    await toolOf(native, "keiko_git_stage").execute(
      { paths: ["src/a.ts"], unstage: true },
      CONTEXT,
    );
    const proposalId = mintProposalId("unstage");
    await toolOf(native, "keiko_git_execute").execute({ kind: "unstage", proposalId }, CONTEXT);
    expect(native.fetches.map((call) => call.body)).toMatchObject([
      { action: "git", operation: "stage", phase: "propose", paths: ["src/a.ts"] },
      { action: "git", operation: "unstage", phase: "propose", paths: ["src/a.ts"] },
      { action: "git", operation: "unstage", phase: "execute", proposalId },
    ]);
    for (const call of native.fetches) expect(call.body).not.toHaveProperty("unstage");
  });

  it("propose a commit and redeem it with the literal wire fields the facade expects", async () => {
    const native = await load("native", "autonomous-delivery");
    await toolOf(native, "keiko_git_commit").execute({ message: "feat: add a" }, CONTEXT);
    const proposalId = mintProposalId("commit");
    await toolOf(native, "keiko_git_execute").execute({ kind: "commit", proposalId }, CONTEXT);
    expect(native.fetches.map((call) => call.body)).toMatchObject([
      { action: "delivery", intent: "commit", phase: "propose", message: "feat: add a" },
      { action: "delivery", intent: "commit", phase: "execute", proposalId },
    ]);
  });

  // #3902 AC2: keiko_git_sync names its operation on the wire, never its `pull` flag. Below Full
  // access it asks the operator first, as the operation it is, and redeems that approval.
  it("fetch and pull through keiko_git_sync, asking the operator first below Full access", async () => {
    for (const mode of ["governed-assist", "supervised-coding"]) {
      const native = await load("native", mode);
      await toolOf(native, "keiko_git_sync").execute({ pull: false }, CONTEXT);
      await toolOf(native, "keiko_git_sync").execute({ pull: true }, CONTEXT);
      const bodies = native.fetches.map((call) => call.body);
      expect(bodies.map((body) => body.action)).toEqual([
        "permission-request",
        "git",
        "permission-request",
        "git",
      ]);
      expect(bodies[0]).toMatchObject({
        properties: {
          patterns: ["fetch"],
          metadata: { actionKind: "git-fetch", kind: "command-execution", commandLabel: "fetch" },
        },
      });
      expect(bodies[2]).toMatchObject({
        properties: { patterns: ["pull"], metadata: { actionKind: "git-pull" } },
      });
      expect(bodies[1]).toMatchObject({ action: "git", operation: "fetch" });
      expect(bodies[3]).toMatchObject({ action: "git", operation: "pull" });
      for (const body of [bodies[1], bodies[3]]) {
        expect(body).not.toHaveProperty("pull");
        expect(body?.approvalProof).toMatchObject({ approvalId: body?.actionId });
      }
    }
    const full = await load("native", "autonomous-delivery");
    await toolOf(full, "keiko_git_sync").execute({ pull: true }, CONTEXT);
    expect(full.fetches.map((call) => call.body)).toEqual([
      expect.objectContaining({ action: "git", operation: "pull" }),
    ]);
    expect(full.fetches[0]?.body).not.toHaveProperty("approvalProof");
  });

  // #3907: keiko_git_branch's `name` is the wire's `branchName`. Below Full access it asks first,
  // naming the branch only by the digest its approval is bound to, and redeems that approval.
  it("create a task branch with the wire field the facade expects, asking first below Full access", async () => {
    for (const mode of ["governed-assist", "supervised-coding"]) {
      const native = await load("native", mode);
      await toolOf(native, "keiko_git_branch").execute({ name: "feature/x" }, CONTEXT);
      const bodies = native.fetches.map((call) => call.body);
      expect(bodies.map((body) => body.action)).toEqual(["permission-request", "git"]);
      const digest = createHash("sha256").update("feature/x", "utf8").digest("hex");
      expect(bodies[0]).toMatchObject({
        properties: {
          patterns: ["branch"],
          metadata: {
            actionKind: "git-branch",
            kind: "command-execution",
            commandLabel: "branch",
            risk: "medium",
            targetPathHash: digest,
          },
        },
      });
      expect(JSON.stringify(bodies[0])).not.toContain("feature/x");
      expect(bodies[1]).toMatchObject({
        action: "git",
        operation: "branch",
        branchName: "feature/x",
      });
      expect(bodies[1]).not.toHaveProperty("name");
      expect(bodies[1]?.approvalProof).toMatchObject({ approvalId: bodies[1]?.actionId });
    }
    const full = await load("native", "autonomous-delivery");
    await toolOf(full, "keiko_git_branch").execute({ name: "feature/x" }, CONTEXT);
    expect(full.fetches.map((call) => call.body)).toEqual([
      expect.objectContaining({ action: "git", operation: "branch", branchName: "feature/x" }),
    ]);
    expect(full.fetches[0]?.body).not.toHaveProperty("approvalProof");
  });

  it("ask the operator first for a verification below Full access, as the mapped tool does", async () => {
    const native = await load("native", "governed-assist");
    await toolOf(native, "keiko_verification").execute(ARGUMENTS.keiko_verification ?? {}, CONTEXT);
    expect(native.fetches.map((call) => call.body.action)).toEqual([
      "permission-request",
      "verification",
    ]);
    expect(native.fetches[1]?.body.approvalProof).toMatchObject({
      approvalId: native.fetches[1]?.body.actionId,
    });
    const full = await load("native", "autonomous-delivery");
    await toolOf(full, "keiko_verification").execute(ARGUMENTS.keiko_verification ?? {}, CONTEXT);
    expect(full.fetches.map((call) => call.body.action)).toEqual(["verification"]);
  });

  // #3903 AC3: the native plugin makes Keiko's provider the websearch service's default, and the
  // provider asks the server for exactly the query, then hands the producer its results.
  it("register Keiko's web search provider as the default, natively only", async () => {
    const results = [{ url: "https://example.test/one", title: "One", published: 1 }];
    const native = await load("native", "autonomous-delivery", { results });
    expect(native.webSearch.providers.map((provider) => provider.id)).toEqual(["keiko"]);
    expect(native.webSearch.selected).toBe("keiko");
    const [provider] = native.webSearch.providers;
    await expect(provider?.execute({ query: "governed search" }, {})).resolves.toEqual([
      { url: "https://example.test/one", title: "One", time: { published: 1 } },
    ]);
    expect(native.fetches.map((call) => call.body)).toEqual([
      { action: "web-search", runId: "run-native-delivery", query: "governed search" },
    ]);
    const mapped = await load("direct", "autonomous-delivery");
    expect(mapped.webSearch.providers).toEqual([]);
  });

  it("refuse every late call once the producer disposes the plugin", async () => {
    const native = await load("native", "autonomous-delivery");
    native.dispose();
    await expect(toolOf(native, "keiko_git_status").execute({}, CONTEXT)).rejects.toThrow(
      "keiko-tool-unavailable",
    );
    expect(native.fetches).toHaveLength(0);
  });
});

/** What a delivery proposes: staging, the commit, the push and the draft pull request. */
const DELIVERY_PROPOSALS = [
  "keiko_git_stage",
  "keiko_git_commit",
  "keiko_git_push",
  "keiko_pull_request",
  "keiko_git_execute",
];
/** Every tool the guidance must name for the model to complete a verified delivery. */
const DELIVERY_STEPS = [
  ...DELIVERY_PROPOSALS,
  "keiko_verification",
  "keiko_ci_status",
  "keiko_git_sync",
  "keiko_git_branch",
];

const POINTER_TOOL = /keiko_[a-z_]+/gu;

function namedTools(text: string): readonly string[] {
  return text.match(POINTER_TOOL) ?? [];
}

describe("the pointer from the shell to the delivery tools", () => {
  const WORKSPACE = "/work/space";
  const decide = (mode: string, command: string): ReturnType<typeof decideOpenCodeNativePolicy> =>
    decideOpenCodeNativePolicy({
      mode,
      workspaceRoot: WORKSPACE,
      request: {
        runId: "run-native-delivery",
        sessionID: "ses_native0000000000001",
        permission: "shell",
        resources: [command],
      },
      nowMs: 0,
    });

  it.each([
    "git commit -am done",
    "git push origin HEAD",
    "npm test && git commit -m done",
    "gh pr create --fill",
    // #3902 AC2: synchronization stays a Keiko action too; the shell keeps refusing it.
    "git fetch origin",
    "git pull --ff-only origin main",
    "git -C . fetch --all",
  ])("tells the model which Keiko tools deliver when `%s` is refused, in every mode", (command) => {
    for (const mode of ["governed-assist", "supervised-coding", "autonomous-delivery"]) {
      const decision = decide(mode, command);
      expect(decision.effect).toBe("deny");
      if (decision.effect !== "deny") throw new Error("expected a denial");
      expect(decision.reason).toBe("delivery-reserved");
      expect(decision.message).toBe(OPENCODE_NATIVE_DELIVERY_REFUSAL_MESSAGE);
    }
  });

  it("names only tools the native run has, and every tool a delivery needs", () => {
    const named = new Set(namedTools(OPENCODE_NATIVE_DELIVERY_REFUSAL_MESSAGE));
    for (const name of named) expect(isOpenCodeNativeDeliveryToolName(name), name).toBe(true);
    for (const name of [...DELIVERY_PROPOSALS, "keiko_git_sync", "keiko_git_branch"])
      expect(named.has(name), name).toBe(true);
    expect(OPENCODE_NATIVE_DELIVERY_REFUSAL_MESSAGE.length).toBeLessThan(560);
  });

  it("is the guidance the native run receives, and names only tools the native run has", () => {
    const named = new Set(namedTools(OPENCODE_NATIVE_PROFILE_CONTEXT_ADDENDUM));
    for (const name of named) expect(isOpenCodeNativeDeliveryToolName(name), name).toBe(true);
    for (const name of DELIVERY_STEPS) expect(named.has(name), name).toBe(true);
    expect(OPENCODE_NATIVE_PROFILE_CONTEXT_ADDENDUM).not.toContain("Leave verified changes");
  });

  // The producer evaluates no permission for a plugin tool in the native profile (measured on the
  // pinned 2.1.4 in opencodeNativeDelivery.real.test.ts), so a delivery tool never reaches the
  // hook. A permission that did arrive under a tool's name would be unclassified: it stays a
  // fail-closed refusal, never a second path to delivery authority.
  it("treats a permission asserted under a delivery tool's name as unclassified", () => {
    for (const name of OPENCODE_NATIVE_DELIVERY_TOOL_NAMES) {
      const decision = decideOpenCodeNativePolicy({
        mode: "autonomous-delivery",
        workspaceRoot: WORKSPACE,
        request: {
          runId: "run-native-delivery",
          sessionID: "ses_native0000000000001",
          permission: name,
          resources: [],
        },
        nowMs: 0,
      });
      expect(decision, name).toMatchObject({ effect: "deny", reason: "unsupported-action" });
    }
  });
});

describe("the native tool contract admission of the delivery tools", () => {
  const descriptions = new Map(
    opencodeRegistrationSet().entries.map((entry) => [entry.alias, entry.descriptor.description]),
  );

  /** What OpenCode sends the gateway for the delivery tools: the generated schema, closed. */
  function advertisedDelivery(): {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }[] {
    return OPENCODE_MODEL_VISIBLE_TOOLS.filter((tool) =>
      isOpenCodeNativeDeliveryToolName(tool.name),
    ).map((tool) => ({
      name: tool.name,
      description: descriptions.get(tool.name) ?? "",
      parameters: { ...projectedGatewaySchema(tool.name, tool.parameters) },
    }));
  }

  function nativeInventory(): {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }[] {
    return OPENCODE_NATIVE_TOOL_NAMES.map((name) => ({
      name,
      description: `OpenCode ${name}`,
      parameters: { type: "object", properties: {} },
    }));
  }

  it("admits the delivery tools beside OpenCode's own, with their real descriptions", () => {
    const delivery = advertisedDelivery();
    expect(delivery.map((tool) => tool.name).sort()).toEqual(EXPECTED_DELIVERY_TOOLS);
    for (const tool of delivery) expect(tool.description.length, tool.name).toBeGreaterThan(0);
    const advertised = [...nativeInventory(), ...delivery];
    expect(hasExactOpenCodeVisibleToolContract(advertised, "native")).toBe(true);
    const advertisement = createOpenCodeNativeToolAdvertisement(advertised, Date.now(), 60_000);
    expect(isGatewayNativeToolAdvertisement(advertisement)).toBe(true);
    expect(advertisement.tools.map((tool) => tool.name)).toEqual(
      advertised.map((tool) => tool.name),
    );
  });

  it("still refuses the same delivery tools under the mapped profiles' exact contracts", () => {
    const advertised = [...nativeInventory(), ...advertisedDelivery()];
    expect(hasExactOpenCodeVisibleToolContract(advertised, "direct")).toBe(false);
    expect(hasExactOpenCodeVisibleToolContract(advertised, "code-mode")).toBe(false);
  });

  it("keeps the delivery arguments under full redaction: none is exact workspace content", () => {
    for (const name of OPENCODE_NATIVE_DELIVERY_TOOL_NAMES)
      expect(GATEWAY_NATIVE_EXACT_CONTENT_TOOLS, name).not.toContain(name);
  });
});
