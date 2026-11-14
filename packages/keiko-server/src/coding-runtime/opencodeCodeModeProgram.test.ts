import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mcpToolAction } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";

import { codingJiraServerDefinition } from "./codingJiraPodBinding.js";
import { openCodeNativeMcpAdmission } from "./opencodeNativeMcp.js";
import { OPENCODE_NATIVE_TOOL_DEFINITIONS } from "./opencodeNativeTools.js";
import {
  decideOpenCodeNativePolicy,
  type OpenCodeNativePolicyDecision,
  type OpenCodeNativePolicyRequest,
} from "./opencodeNativePolicy.js";
import {
  OPENCODE_CODE_MODE_GOVERNED_TOOLS,
  OPENCODE_CODE_MODE_PROGRAM,
  OPENCODE_CODE_MODE_SESSION_MOVE,
  OPENCODE_CODE_MODE_WORKTREE_CREATE,
  createGeneratedOpenCodeNativePolicyPlugin,
} from "./opencodeNativePolicyPlugin.js";
import { OPENCODE_PINNED_VERSION, openCodeRuntimeVersionPin } from "./opencodeRuntimeVersions.js";

// #4359: a Code Mode program asserts no permission and can only call its nested tools. On a runtime
// whose pin says every nested effect reaches the policy as its own decision, the program itself
// passes without a card; the effects below were observed live on that runtime in Ask for approval and
// Full access (`coding-runtime.native-policy.decided`), and each keeps its own decision here. A runtime
// the pin does not vouch for keeps the program's card (fail closed).

const MODES = ["governed-assist", "supervised-coding", "autonomous-delivery"] as const;
const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const PROGRAM_TEXT = ["const r = await fetch('https://example.com');", "return r.status;"];

let root: string;
let workspace: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-code-mode-program-")));
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
    runId: "run-code-mode-program",
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
  nestedDecided: boolean | undefined,
  overrides: Partial<OpenCodeNativePolicyRequest> = {},
  mcp?: Parameters<typeof decideOpenCodeNativePolicy>[0]["mcp"],
): readonly string[] {
  return MODES.map((mode) =>
    outcome(
      decideOpenCodeNativePolicy({
        mode,
        workspaceRoot: workspace,
        request: request(permission, resources, overrides),
        nowMs: NOW,
        ...(mcp === undefined ? {} : { mcp }),
        ...(nestedDecided === undefined ? {} : { codeModeNestedEffectsDecided: nestedDecided }),
      }),
    ),
  );
}

describe("the Code Mode program itself", () => {
  it("passes without a card in every mode on a runtime whose pin decides nested effects", () => {
    expect(decisions(OPENCODE_CODE_MODE_PROGRAM, PROGRAM_TEXT, true)).toEqual([
      "allow",
      "allow",
      "allow",
    ]);
    // The text is not needed for review any more: a program sending none passes as well.
    expect(decisions(OPENCODE_CODE_MODE_PROGRAM, [], true)).toEqual(["allow", "allow", "allow"]);
  });

  it.each([undefined, false])(
    "keeps asking below Full access when the runtime is not known to decide nested effects (%s)",
    (flag) => {
      expect(decisions(OPENCODE_CODE_MODE_PROGRAM, PROGRAM_TEXT, flag)).toEqual([
        "ask",
        "ask",
        "allow",
      ]);
    },
  );

  it("refuses a program that offers no text to review below Full access when the card is kept", () => {
    expect(decisions(OPENCODE_CODE_MODE_PROGRAM, [], undefined)).toEqual([
      "deny:nothing-to-review",
      "deny:nothing-to-review",
      "allow",
    ]);
  });

  it("is vouched for by the pin of the runtime Keiko approves, and by no unknown version", () => {
    expect(openCodeRuntimeVersionPin(OPENCODE_PINNED_VERSION)?.decidesNestedEffects).toBe(true);
    for (const version of ["9.9.9", "", "constructor", undefined]) {
      expect(openCodeRuntimeVersionPin(version)?.decidesNestedEffects).not.toBe(true);
    }
  });

  it("sends no program text for review from the plugin of a pin that decides nested effects", () => {
    const decided = createGeneratedOpenCodeNativePolicyPlugin({ programReviewed: false });
    expect(decided).toContain("const PROGRAM_REVIEWED = false;");
    expect(decided).toContain('event.tool === "execute" ? (PROGRAM_REVIEWED');
    expect(decided).toContain("managementResources(event.tool, event.input)");
  });

  it("keeps sending the program for review by default, and for a pin that does not vouch", () => {
    expect(createGeneratedOpenCodeNativePolicyPlugin()).toContain("const PROGRAM_REVIEWED = true;");
    expect(createGeneratedOpenCodeNativePolicyPlugin({ programReviewed: true })).toContain(
      "const PROGRAM_REVIEWED = true;",
    );
  });
});

// One pin per effect kind a program can cause. A decision does not change because the program's own
// card is gone: Ask for approval and Full access are the two modes observed live on the runtime.
describe("every nested effect keeps its own decision when the program passes without a card", () => {
  const programPasses = true;

  it("moving the run's session inside the workspace is navigation: allowed", () => {
    expect(
      decisions(OPENCODE_CODE_MODE_SESSION_MOVE, [join(workspace, "sub")], programPasses),
    ).toEqual(["allow", "allow", "allow"]);
  });

  it("moving it outside the workspace is a hard denial in every mode", () => {
    expect(
      decisions(OPENCODE_CODE_MODE_SESSION_MOVE, [join(root, "elsewhere")], programPasses),
    ).toEqual(["deny:workspace-escape", "deny:workspace-escape", "deny:workspace-escape"]);
  });

  it("adding a worktree is asked below Full access and in Full access too (delivery scope)", () => {
    const [ask, , full] = decisions(
      OPENCODE_CODE_MODE_WORKTREE_CREATE,
      ["inv-probe"],
      programPasses,
    );
    expect(ask).toBe("ask");
    expect(full).toBe("ask");
  });

  it("removing a worktree is an edit of its directory: asked in Ask, allowed in Full", () => {
    const [ask, , full] = decisions("edit", [join(workspace, "sub")], programPasses);
    expect(ask).toBe("ask");
    expect(full).toBe("allow");
  });

  it("a web fetch is refused below Full access and allowed in Full access", () => {
    const [ask, supervised, full] = decisions("webfetch", ["https://example.com/"], programPasses);
    expect(ask).toBe("deny:mode-denied");
    expect(supervised).toBe("deny:mode-denied");
    expect(full).toBe("allow");
  });

  it("an action the policy does not classify stays refused", () => {
    expect(decisions("bash-in-a-program", ["x"], programPasses)).toEqual([
      "deny:unsupported-action",
      "deny:unsupported-action",
      "deny:unsupported-action",
    ]);
  });

  describe("MCP effects through the managed Jira Pod relay", () => {
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

    it("allows a nested Jira read in every mode", () => {
      expect(decisions(mcpToolAction("jira", "jira.issue"), ["*"], true, {}, grants)).toEqual([
        "allow",
        "allow",
        "allow",
      ]);
    });

    it("asks for a nested Jira write below Full access: that one ask is the person's card", () => {
      expect(decisions(mcpToolAction("jira", "jira.create"), ["*"], true, {}, grants)).toEqual([
        "ask",
        "ask",
        "allow",
      ]);
    });

    it("lists and reads the resources of the run's own managed server without a card", () => {
      for (const tool of ["opencode_list_mcp_resources", "opencode_read_mcp_resource"]) {
        expect(decisions(tool, ["jira"], true, {}, grants), tool).toEqual([
          "allow",
          "allow",
          "allow",
        ]);
      }
    });

    it("never admits the resources of a server the run does not have", () => {
      expect(
        decisions("opencode_list_mcp_resources", ["somewhere-else"], true, {}, grants),
      ).toEqual(["deny:unsupported-action", "deny:unsupported-action", "deny:unsupported-action"]);
      expect(decisions("opencode_list_mcp_resources", ["jira", "other"], true, {}, grants)).toEqual(
        ["deny:unsupported-action", "deny:unsupported-action", "deny:unsupported-action"],
      );
    });
  });

  // The worktree listing and the model search change no file, command, state or network, so they
  // assert no permission and the plugin does not govern them: undecided by design (ADR-0137).
  it.each(["opencode_worktree_list", "opencode_models"])(
    "%s is a pure read that decides nothing, by design",
    (tool) => {
      expect(OPENCODE_CODE_MODE_GOVERNED_TOOLS).not.toContain(tool);
      const definition = OPENCODE_NATIVE_TOOL_DEFINITIONS.find(
        (candidate) => candidate.id === tool,
      );
      expect(definition?.codemode).toBe(true);
    },
  );
});
