import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mcpToolAction } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";

import { codingJiraServerDefinition } from "./codingJiraPodBinding.js";
import { OPENCODE_CODE_MODE_GOVERNED_TOOLS } from "./opencodeNativePolicyPlugin.js";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  decideOpenCodeNativePolicy,
  recordOpenCodeNativePolicyDecision,
  type OpenCodeNativePolicyDecision,
  type OpenCodeNativePolicyRequest,
} from "./opencodeNativePolicy.js";
import { openCodeNativeMcpAdmission } from "./opencodeNativeMcp.js";
import { OPENCODE_NATIVE_TOOL_DEFINITIONS } from "./opencodeNativeTools.js";

// #4359 (F26 / owner decision on the outer `execute` card): what a Code Mode program can do is
// exactly its nested tool calls, and each reaches the native policy as its own decision. This file
// pins every effect of a program to the decision that governs it, in all three modes, so removing
// or narrowing the outer program card is a decision with a complete list in front of it.
// Producer facts (ADR-0137 "Code Mode stays available"): the catalog lists exactly eight
// `tools.opencode.*` management tools; read/edit/shell/write are not callable inside a program;
// `execute.before` fires for the program and for every nested call; the permission hook fires only
// for the nested tools that assert a permission.

const MODES = ["governed-assist", "supervised-coding", "autonomous-delivery"] as const;
const NOW = Date.parse("2026-11-14T12:00:00.000Z");

let root: string;
let workspace: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-code-mode-effects-")));
  workspace = join(root, "workspace");
  mkdirSync(join(workspace, "sub"), { recursive: true });
  mkdirSync(join(root, "elsewhere"), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function request(
  permission: string,
  resources: readonly string[],
  overrides: Partial<OpenCodeNativePolicyRequest> = {},
): OpenCodeNativePolicyRequest {
  return {
    runId: "run-code-mode",
    sessionID: "ses_native0000000000001",
    agent: "build",
    permission,
    resources,
    source: { messageID: "msg_1", id: "call_1" },
    ...overrides,
  };
}

function outcome(decision: OpenCodeNativePolicyDecision): string {
  return decision.effect === "deny" ? `deny:${decision.reason}` : decision.effect;
}

function decisions(
  permission: string,
  resources: readonly string[],
  overrides: Partial<OpenCodeNativePolicyRequest> = {},
  extra: { readonly mcp?: Parameters<typeof decideOpenCodeNativePolicy>[0]["mcp"] } = {},
): readonly string[] {
  return MODES.map((mode) =>
    outcome(
      decideOpenCodeNativePolicy({
        mode,
        workspaceRoot: workspace,
        request: request(permission, resources, overrides),
        nowMs: NOW,
        ...extra,
      }),
    ),
  );
}

const MANAGEMENT_TOOLS = OPENCODE_NATIVE_TOOL_DEFINITIONS.filter(
  (tool) => tool.codemode && tool.id.startsWith("opencode_"),
).map((tool) => tool.id);

/**
 * How each management tool a program can call is decided: by the plugin's tool hook before it
 * runs ("tool-hook"), by the permission the producer itself asserts for it ("permission-hook"), or
 * by nothing because it only reads ("read": the worktree listing and the model search change no
 * state, no file, no command and no network).
 */
const DECIDED_BY: Readonly<Record<string, "tool-hook" | "permission-hook" | "read">> = {
  opencode_session_move: "tool-hook",
  opencode_session_rename: "tool-hook",
  opencode_worktree_create: "tool-hook",
  opencode_worktree_remove: "permission-hook",
  opencode_list_mcp_resources: "permission-hook",
  opencode_read_mcp_resource: "permission-hook",
  opencode_worktree_list: "read",
  opencode_models: "read",
};

describe("every effect of a Code Mode program reaches the native policy", () => {
  it("lists exactly the eight management tools, each with its deciding source", () => {
    expect([...MANAGEMENT_TOOLS].sort()).toEqual(Object.keys(DECIDED_BY).sort());
    expect(MANAGEMENT_TOOLS).toHaveLength(8);
  });

  it("governs through the tool hook exactly the tools it says it does", () => {
    const hooked = Object.entries(DECIDED_BY)
      .filter(([, source]) => source === "tool-hook")
      .map(([tool]) => tool);
    expect([...OPENCODE_CODE_MODE_GOVERNED_TOOLS].sort()).toEqual(hooked.sort());
  });

  it("leaves no state change undecided: only the two pure reads decide nothing", () => {
    const reads = Object.entries(DECIDED_BY)
      .filter(([, source]) => source === "read")
      .map(([tool]) => tool)
      .sort();
    expect(reads).toEqual(["opencode_models", "opencode_worktree_list"]);
  });

  // HELD, not changed (#4359): the owner agreed to drop the program card if every effect of a
  // program is decided on its own. A live run (2026-11-14, Ask for approval and Full access,
  // OpenCode 2.1.4, the payload of the installed runtime package) showed one that is not: a `fetch` inside a program produced no `webfetch`
  // decision line at all (in Full access it reached the open internet; below Full access only the
  // kernel's egress rule stopped it). Until `fetch` is decided, the program keeps its card.
  it("keeps asking for the program itself below Full access", () => {
    expect(decisions("execute", ["return 1;"])).toEqual(["ask", "ask", "allow"]);
    expect(decisions("execute", [])).toEqual([
      "deny:nothing-to-review",
      "deny:nothing-to-review",
      "allow",
    ]);
  });

  it("never lets a stricter mode allow what a looser one asks (monotonic)", () => {
    const rank: Readonly<Record<string, number>> = { allow: 0, ask: 1 };
    const probes: readonly (readonly [string, readonly string[]])[] = [
      ["execute", ["return 1;"]],
      ["opencode_session_rename", ["A title"]],
      ["opencode_worktree_create", ["feature-x"]],
      ["opencode_schedule", ["create", 'when:{"type":"at","at":"in 5 minutes"}']],
      ["edit", [join(workspace, "sub")]],
    ];
    for (const [permission, resources] of probes) {
      const [strict, middle, loose] = decisions(permission, resources).map(
        (outcome) => rank[outcome],
      );
      expect(strict, permission).toBeGreaterThanOrEqual(middle ?? -1);
      expect(middle, permission).toBeGreaterThanOrEqual(loose ?? -1);
    }
  });

  it("logs an allowed rename with its closed permission, body-free", () => {
    const lines: ServerLogEvent[] = [];
    const req = request("opencode_session_rename", ["A title"]);
    recordOpenCodeNativePolicyDecision(
      { write: (event) => void lines.push(event) },
      "run-code-mode",
      {
        mode: "governed-assist",
        request: req,
        decision: decideOpenCodeNativePolicy({
          mode: "governed-assist",
          workspaceRoot: workspace,
          request: req,
          nowMs: NOW,
        }),
        outcome: "allowed",
      },
    );
    expect(
      expectActivityLogProof(
        "coding-runtime.native-policy.decided.emitted-line",
        formatActivityLogProofLine(lines[0] ?? {}),
      ),
    ).toMatchObject({ permission: "opencode_session_rename", effect: "allow", outcome: "allowed" });
    expect(JSON.stringify(lines)).not.toContain("A title");
  });

  it("decides a session rename like a move: allowed for the run's own session in every mode", () => {
    expect(decisions("opencode_session_rename", ["A new title"])).toEqual([
      "allow",
      "allow",
      "allow",
    ]);
    const refused = [
      "deny:unsupported-action",
      "deny:unsupported-action",
      "deny:unsupported-action",
    ];
    expect(
      decisions("opencode_session_rename", ["A title"], {
        targetSessionID: "ses_other00000000000002",
      }),
    ).toEqual(refused);
    expect(decisions("opencode_session_rename", ["two\nlines"])).toEqual(refused);
    for (const breaking of ["\u0085", "\u2028", "\u2029", "\u009f", "\u007f"])
      expect(decisions("opencode_session_rename", [`a${breaking}b`]), breaking).toEqual(refused);
    // A request that names no calling session never matches a missing target.
    expect(
      decisions("opencode_session_rename", ["A title"], {
        sessionID: undefined as unknown as string,
      }),
    ).toEqual(refused);
    expect(decisions("opencode_session_rename", ["x".repeat(201)])).toEqual(refused);
    expect(decisions("opencode_session_rename", ["   "])).toEqual(refused);
    expect(decisions("opencode_session_rename", [])).toEqual(refused);
  });

  it("decides a session move inside the workspace as navigation in every mode, and refuses the rest", () => {
    const inside = join(workspace, "sub");
    expect(decisions("opencode_session_move", [inside])).toEqual(["allow", "allow", "allow"]);
    const refused = ["deny:workspace-escape", "deny:workspace-escape", "deny:workspace-escape"];
    expect(decisions("opencode_session_move", [join(root, "elsewhere")])).toEqual(refused);
    const unsupported = [
      "deny:unsupported-action",
      "deny:unsupported-action",
      "deny:unsupported-action",
    ];
    expect(
      decisions("opencode_session_move", [inside], { targetSessionID: "ses_other00000000000002" }),
    ).toEqual(unsupported);
    expect(decisions("opencode_session_move", ["relative/dir"])).toEqual(unsupported);
  });

  it("decides a new worktree as a delivery-scoped action and refuses an unnamed one", () => {
    expect(decisions("opencode_worktree_create", ["feature-x"])).toEqual(["ask", "ask", "ask"]);
    const unsupported = [
      "deny:unsupported-action",
      "deny:unsupported-action",
      "deny:unsupported-action",
    ];
    expect(decisions("opencode_worktree_create", ["not a name!"])).toEqual(unsupported);
  });

  it("decides a worktree removal as an edit of its directory", () => {
    expect(decisions("edit", [join(workspace, "sub")])).toEqual(["ask", "allow", "allow"]);
    expect(decisions("edit", [join(root, "elsewhere")])).toEqual([
      "deny:workspace-escape",
      "deny:workspace-escape",
      "deny:workspace-escape",
    ]);
  });

  it("decides a schedule change that starts later work: ask, ask, allow", () => {
    expect(
      decisions("opencode_schedule", ["create", 'when:{"type":"at","at":"in 5 minutes"}']),
    ).toEqual(["ask", "ask", "allow"]);
  });

  it("decides a fetch inside a program as the web permission, and a search as unconfigured", () => {
    const fetched = decisions("webfetch", ["https://example.test/page"]);
    expect(fetched[2]).toBe("allow");
    expect(fetched[0]).toBe("deny:mode-denied");
    expect(fetched[1]).toBe("deny:mode-denied");
    expect(decisions("websearch", ["query"])).toEqual([
      "deny:unsupported-action",
      "deny:unsupported-action",
      "deny:unsupported-action",
    ]);
  });

  it("refuses every other permission a program might assert", () => {
    for (const permission of ["bash", "net", "opencode_session_delete", "opencode_anything"])
      expect(decisions(permission, ["x"]), permission).toEqual([
        "deny:unsupported-action",
        "deny:unsupported-action",
        "deny:unsupported-action",
      ]);
  });

  describe("the nested Jira Pod tools of the run", () => {
    const READS = ["jira.projects", "jira.issue-types", "jira.create-fields", "jira.issue"];
    const WRITES = ["jira.create", "jira.edit", "jira.comment", "jira.transition"];
    const grants = openCodeNativeMcpAdmission({
      servers: [
        codingJiraServerDefinition({
          podId: "0d6c5d3e-7a41-4f0e-9a52-3c1f8e4b7a10",
          authenticationGeneration: 3,
          verificationRevision: 1,
        }),
      ],
      mode: "governed-assist",
      home: "/synthetic/home",
      platform: "linux",
      managed: true,
      relays: new Map([
        ["jira", { url: "http://127.0.0.1:1983/relay", capability: "synthetic-capability" }],
      ]),
      grantedServers: new Set(["jira"]),
    }).grants;

    it("allows every nested read in every mode", () => {
      for (const tool of READS)
        expect(decisions(mcpToolAction("jira", tool), ["*"], {}, { mcp: grants }), tool).toEqual([
          "allow",
          "allow",
          "allow",
        ]);
    });

    it("asks for every nested write below Full access", () => {
      for (const tool of WRITES)
        expect(decisions(mcpToolAction("jira", tool), ["*"], {}, { mcp: grants }), tool).toEqual([
          "ask",
          "ask",
          "allow",
        ]);
    });

    it("refuses a nested tool the run's Pod does not offer", () => {
      expect(
        decisions(mcpToolAction("jira", "jira.delete-everything"), ["*"], {}, { mcp: grants }),
      ).toEqual(["deny:unsupported-action", "deny:unsupported-action", "deny:unsupported-action"]);
    });
  });
});
