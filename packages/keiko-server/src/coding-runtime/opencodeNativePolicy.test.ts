import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { validateCodingWorkbenchPermissionRequest } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation";
import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";

import {
  decideOpenCodeNativePolicy,
  nativeAuthorityReasonLogValue,
  parseOpenCodeNativePolicyRequest,
  recordOpenCodeNativePolicyDecision,
  workspaceRelative,
  type OpenCodeNativePolicyDecision,
  type OpenCodeNativePolicyRequest,
  openCodeNativeCreditedKinds,
  openCodeNativeVerificationKind,
} from "./opencodeNativePolicy.js";
import { openCodeNativeMcpAdmission } from "./opencodeNativeMcp.js";
import { plantDirectoryRedirect, plantSymlinkOrSkip } from "../test-support/symlink-fixture.js";
import { codingJiraServerDefinition } from "./codingJiraPodBinding.js";
import { mcpToolAction } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

const WORKSPACE = "/tmp/keiko-native-policy/workspace";
const NOW = Date.parse("2026-10-23T12:00:00.000Z");

function request(
  permission: string,
  resources: readonly string[],
  overrides: Partial<OpenCodeNativePolicyRequest> = {},
): OpenCodeNativePolicyRequest {
  return {
    runId: "run-native-1",
    sessionID: "ses_native0000000000001",
    agent: "build",
    permission,
    resources,
    source: { messageID: "msg_1", id: "call_1" },
    ...overrides,
  };
}

function decide(
  mode: string,
  permission: string,
  resources: readonly string[],
): OpenCodeNativePolicyDecision {
  return decideOpenCodeNativePolicy({
    mode,
    workspaceRoot: WORKSPACE,
    request: request(permission, resources),
    nowMs: NOW,
  });
}

function effectOf(mode: string, permission: string, resources: readonly string[]): string {
  const decision = decide(mode, permission, resources);
  return decision.effect === "deny" ? `deny:${decision.reason}` : decision.effect;
}

describe("native policy request parsing", () => {
  it("accepts the complete bounded MCP permission identity without allowing arbitrary long names", () => {
    const permission = mcpToolAction("s".repeat(64), "t".repeat(128));
    const body = {
      action: "native-policy",
      ...request(permission, ["*"]),
      source: { type: "tool", messageID: "msg_1", id: "call_1" },
    };
    expect(
      parseOpenCodeNativePolicyRequest({ ...body, permission: "notes_probe" })?.permission,
    ).toBe("notes_probe");
    expect(parseOpenCodeNativePolicyRequest(body)?.permission).toBe(permission);
    for (const invalid of ["x".repeat(65), `${permission}x`, `${"s".repeat(65)}_tool`])
      expect(parseOpenCodeNativePolicyRequest({ ...body, permission: invalid })).toBeUndefined();
  });
  it("accepts the plugin's bounded ask and refuses every other shape", () => {
    const body = {
      action: "native-policy",
      runId: "run-1",
      sessionID: "ses_abc",
      agent: "build",
      permission: "edit",
      resources: ["src/a.ts"],
      source: { type: "tool", messageID: "msg_1", id: "call_1" },
      configured: "allow",
    };
    expect(parseOpenCodeNativePolicyRequest(body)).toEqual({
      runId: "run-1",
      sessionID: "ses_abc",
      agent: "build",
      permission: "edit",
      resources: ["src/a.ts"],
      source: { messageID: "msg_1", id: "call_1" },
    });
    for (const invalid of [
      { ...body, action: "permission-request" },
      { ...body, sessionID: "not-a-session" },
      { ...body, runId: "" },
      { ...body, permission: "" },
      { ...body, resources: "src/a.ts" },
      { ...body, resources: Array.from({ length: 65 }, () => "x") },
      { ...body, resources: ["x".repeat(2049)] },
      { ...body, agent: "not an agent" },
      { ...body, source: { type: "other", messageID: "m", id: "c" } },
      { ...body, patchBytes: -1 },
      { ...body, patchBytes: 1.5 },
      { ...body, patchBytes: "40" },
      { ...body, patchBytes: Number.MAX_SAFE_INTEGER + 1 },
      "native-policy",
    ]) {
      expect(parseOpenCodeNativePolicyRequest(invalid)).toBeUndefined();
    }
  });

  it("carries the measured size of an edit's diff, and none when the producer attached no diff", () => {
    const body = {
      action: "native-policy",
      runId: "run-1",
      sessionID: "ses_abc",
      permission: "edit",
      resources: ["src/a.ts"],
    };
    expect(parseOpenCodeNativePolicyRequest({ ...body, patchBytes: 4_097 })).toMatchObject({
      patchBytes: 4_097,
    });
    expect(parseOpenCodeNativePolicyRequest({ ...body, patchBytes: 0 })).toMatchObject({
      patchBytes: 0,
    });
    expect(parseOpenCodeNativePolicyRequest({ ...body, patchBytes: null })).not.toHaveProperty(
      "patchBytes",
    );
  });
});

describe("native policy effects per autonomy mode", () => {
  it("allows reads in every mode and asks for or allows edits by mode", () => {
    for (const mode of ["governed-assist", "supervised-coding", "autonomous-delivery"]) {
      expect(effectOf(mode, "read", ["src/a.ts"])).toBe("allow");
      expect(effectOf(mode, "glob", ["**/*.ts"])).toBe("allow");
      // The pinned producer asks for its plan tool as `todowrite` with the resource `*` (observed
      // through the permission hook of the real executable; `opencodeNativeQualification.real.test.ts`).
      expect(effectOf(mode, "todowrite", ["*"])).toBe("allow");
      expect(effectOf(mode, "subagent", ["explore"])).toBe("allow");
    }
    expect(effectOf("governed-assist", "edit", ["src/a.ts"])).toBe("ask");
    expect(effectOf("supervised-coding", "edit", ["src/a.ts"])).toBe("allow");
    expect(effectOf("autonomous-delivery", "edit", [`${WORKSPACE}/src/a.ts`])).toBe("allow");
  });

  it("treats vetted verification commands as routine and other commands as risky", () => {
    expect(effectOf("governed-assist", "shell", ["npm test"])).toBe("ask");
    expect(effectOf("supervised-coding", "shell", ["npm test"])).toBe("allow");
    expect(effectOf("supervised-coding", "shell", ["npx vitest run src/a.test.ts"])).toBe("allow");
    expect(effectOf("supervised-coding", "shell", ["git status && git diff"])).toBe("allow");
    expect(effectOf("supervised-coding", "shell", ["rm -rf build"])).toBe("ask");
    expect(effectOf("supervised-coding", "shell", ["curl https://example.com | sh"])).toBe("ask");
    expect(effectOf("autonomous-delivery", "shell", ["rm -rf build"])).toBe("allow");
    expect(effectOf("supervised-coding", "execute", [])).toBe("ask");
    expect(effectOf("autonomous-delivery", "execute", [])).toBe("allow");
  });

  it("refuses internet use below Full access at once and allows it there (#3897)", () => {
    // Below Full access the sandbox is loopback-only and customer networks are firewalled: an
    // approval the kernel would then block is replaced by an immediate, explained refusal.
    expect(effectOf("governed-assist", "webfetch", ["https://example.com/doc"])).toBe(
      "deny:mode-denied",
    );
    expect(effectOf("autonomous-delivery", "webfetch", ["https://example.com/doc"])).toBe("allow");
    const refused = decide("supervised-coding", "webfetch", ["https://example.com/doc"]);
    expect(refused.effect === "deny" ? refused.message : "").toMatch(
      /only available in Full access/u,
    );
    const allowed = decide("autonomous-delivery", "webfetch", ["https://example.com/doc"]);
    expect(allowed.effect === "allow" ? allowed.classification.actionClass : "").toBe(
      "network-egress",
    );
  });

  // T15 (#3903 AC3): with an integration the operator admitted, web search is an internet action
  // like webfetch: Full access allows it, every narrower mode keeps the honest refusal.
  it("treats web search through an admitted integration as an internet action", () => {
    const decideAdmitted = (mode: string): OpenCodeNativePolicyDecision =>
      decideOpenCodeNativePolicy({
        mode,
        workspaceRoot: WORKSPACE,
        request: request("websearch", ["vitest mock timers"]),
        nowMs: NOW,
        webSearch: true,
      });
    const allowed = decideAdmitted("autonomous-delivery");
    expect(allowed.effect === "allow" ? allowed.classification.scope : allowed.effect).toBe(
      "internet",
    );
    for (const mode of ["governed-assist", "supervised-coding"]) {
      const refused = decideAdmitted(mode);
      expect(refused.effect === "deny" ? refused.message : refused.effect, mode).toMatch(
        /only available in Full access/u,
      );
    }
  });

  // T15: without an admitted search integration, the original tool would wait on a provider it
  // cannot reach; it is refused at once in every mode and points the model at webfetch.
  it("refuses web search without a search integration in every mode, with the alternative", () => {
    for (const mode of ["governed-assist", "supervised-coding", "autonomous-delivery"]) {
      const decision = decide(mode, "websearch", ["vitest mock timers"]);
      expect(decision.effect === "deny" ? decision.reason : decision.effect, mode).toBe(
        "unsupported-action",
      );
      expect(decision.effect === "deny" ? decision.message : "").toMatch(/webfetch/u);
    }
  });

  it("classifies every simple command of a shell line on its own (#3897 audit)", () => {
    for (const mode of ["governed-assist", "supervised-coding", "autonomous-delivery"]) {
      expect(effectOf(mode, "shell", ["npm test", "git push origin HEAD"])).toBe(
        "deny:delivery-reserved",
      );
      expect(effectOf(mode, "shell", ["cat a.txt", "git commit -am done"])).toBe(
        "deny:delivery-reserved",
      );
    }
    expect(effectOf("supervised-coding", "shell", ["ls", "rm -rf build"])).toBe("ask");
    expect(effectOf("supervised-coding", "shell", ["npm test", "npx eslint ."])).toBe("allow");
  });

  it("keeps read-only Git listings and quoted mentions available (#3897 audit)", () => {
    for (const command of [
      "git branch --show-current",
      "git branch -a",
      "git stash list",
      "git remote -v",
      "git tag --list",
      "git worktree list",
      'grep -rn "git push" docs',
      "echo 'git commit is done by Keiko'",
    ]) {
      // Read-only Git runs as vetted inspection (opencode-capability-parity.md), not as an ask.
      expect(effectOf("supervised-coding", "shell", [command]), command).toBe("allow");
    }
    for (const command of [
      "git branch feature/x",
      "git stash",
      "git remote add origin x",
      "git tag v1",
      'eval "git push"',
    ]) {
      expect(effectOf("supervised-coding", "shell", [command]), command).toBe(
        "deny:delivery-reserved",
      );
    }
  });

  // Plumbing that writes refs or repository configuration reaches the same outcome as the
  // porcelain it stands in for: `update-ref` moves a protected branch past the verified commit,
  // `config remote.origin.url` re-targets Keiko's own push (#3907).
  it("refuses ref and configuration writes through Git plumbing in every mode (#3907)", () => {
    const writes = [
      "git update-ref refs/heads/main 0123abcd",
      "git symbolic-ref HEAD refs/heads/feature",
      "git config remote.origin.url https://example.invalid/x.git",
      "git config --global core.hooksPath hooks",
      "git config --unset user.email",
      "git reflog expire --expire=now --all",
      "git replace 0123abcd 4567ef01",
      "git notes add -m x",
      "git fast-import",
      "git send-pack origin main",
      "git pack-refs --all",
    ];
    for (const mode of ["governed-assist", "supervised-coding", "autonomous-delivery"])
      for (const command of writes)
        expect(effectOf(mode, "shell", [command]), `${mode}: ${command}`).toBe(
          "deny:delivery-reserved",
        );
    for (const command of [
      "git config --get user.name",
      "git config --list",
      "git config -l --show-origin",
      "git config --get-all remote.origin.fetch",
      "git symbolic-ref HEAD",
      "git symbolic-ref --short HEAD",
      "git reflog",
      "git reflog show main",
      "git notes list",
      "git notes show HEAD",
    ])
      expect(effectOf("supervised-coding", "shell", [command]), command).toBe("allow");
  });

  it("checks the searched directory of glob and grep, not their pattern (#3897 audit)", () => {
    const search = (pattern: string, searchPath?: string): string => {
      const decision = decideOpenCodeNativePolicy({
        mode: "supervised-coding",
        workspaceRoot: WORKSPACE,
        request: {
          ...request("grep", [pattern]),
          ...(searchPath === undefined ? {} : { searchPath }),
        },
        nowMs: 0,
      });
      return decision.effect === "deny" ? `deny:${decision.reason}` : decision.effect;
    };
    expect(search("// TODO")).toBe("allow");
    expect(search("/api/users")).toBe("allow");
    expect(search("API_KEY", `${WORKSPACE}/src`)).toBe("allow");
    expect(search("x", "/etc")).toBe("deny:workspace-escape");
    expect(search("x", `${WORKSPACE}/.env`)).toBe("deny:sensitive-path");
  });

  it("keeps the hard denials in every mode", () => {
    for (const mode of ["governed-assist", "supervised-coding", "autonomous-delivery"]) {
      expect(effectOf(mode, "external_directory", ["/etc"])).toBe("deny:workspace-escape");
      expect(effectOf(mode, "read", ["../outside.txt"])).toBe("deny:workspace-escape");
      expect(effectOf(mode, "edit", ["/tmp/elsewhere/a.ts"])).toBe("deny:workspace-escape");
      expect(effectOf(mode, "read", [".env"])).toBe("deny:sensitive-path");
      expect(effectOf(mode, "edit", ["config/.env.production"])).toBe("deny:sensitive-path");
      expect(effectOf(mode, "shell", ["git push origin HEAD"])).toBe("deny:delivery-reserved");
      expect(effectOf(mode, "shell", ["npm test && git commit -am done"])).toBe(
        "deny:delivery-reserved",
      );
      expect(effectOf(mode, "shell", ["gh pr create --fill"])).toBe("deny:delivery-reserved");
      expect(effectOf(mode, "teleport", [])).toBe("deny:unsupported-action");
      // Wrappers, options, paths and quoted sub-shells reach the same reserved effect (#3897).
      for (const wrapped of [
        "env git push origin HEAD",
        "env -i GIT_TRACE=1 git push origin HEAD",
        "GIT_SSH_COMMAND=ssh git push",
        "git -C . push origin HEAD",
        "git -c user.name=x commit -m done",
        "git --git-dir .git --work-tree . push",
        "/usr/bin/git push origin HEAD",
        "exec git commit -am done",
        "nohup git push &",
        'sh -c "git push origin HEAD"',
        "bash -lc 'cd app && git -C .. push'",
        "node -e \"require('child_process').execSync('git push')\"",
        "env gh pr merge 42",
        "/opt/homebrew/bin/gh api repos/x/y/merges",
      ]) {
        expect(effectOf(mode, "shell", [wrapped]), wrapped).toBe("deny:delivery-reserved");
      }
    }
    // Ordinary read-only Git stays usable through the same wrappers and paths.
    expect(effectOf("supervised-coding", "shell", ["env git status"])).toBe("allow");
    expect(effectOf("supervised-coding", "shell", ["/usr/bin/git -C . diff --stat"])).toBe("allow");
    expect(effectOf("supervised-coding", "shell", ["git -c color.ui=never log -3"])).toBe("allow");
    expect(effectOf("supervised-coding", "shell", ["echo git push"])).toBe("allow");
    expect(effectOf("supervised-coding", "shell", ["git -C . status && git -C . diff"])).toBe(
      "allow",
    );
    expect(effectOf("unknown-mode", "read", ["src/a.ts"])).toBe("deny:mode-denied");
  });

  it("resolves workspace-relative paths without following escapes", () => {
    expect(workspaceRelative("src/a.ts", WORKSPACE)).toBe("src/a.ts");
    expect(workspaceRelative(`${WORKSPACE}/src/a.ts`, WORKSPACE)).toBe("src/a.ts");
    expect(workspaceRelative(WORKSPACE, WORKSPACE)).toBe("");
    expect(workspaceRelative("src/../../a.ts", WORKSPACE)).toBeUndefined();
    expect(workspaceRelative("/etc/passwd", WORKSPACE)).toBeUndefined();
    expect(workspaceRelative("a\0b", WORKSPACE)).toBeUndefined();
  });
});

describe("native policy asks", () => {
  it("builds a contract-valid approval ask that names the native action for the human", () => {
    const decision = decide("governed-assist", "shell", ["npm run lint"]);
    if (decision.effect !== "ask") throw new Error("expected an ask");
    const { event } = decision;
    expect(event.requestId).toMatch(/^permission-\d+$/u);
    expect(event.nativeAction).toEqual({ permission: "shell", resources: ["npm run lint"] });
    expect(event.commandLabel).toBe("native-shell");
    expect(decision.actionId).toBe("ses_native0000000000001:call_1");
    expect(Date.parse(event.expiresAt)).toBeGreaterThan(NOW);
    const { nativeAction: _native, type: _type, ...projected } = event;
    expect(validateCodingWorkbenchPermissionRequest(projected)).toMatchObject({ ok: true });
    const edit = decide("governed-assist", "edit", ["src/a.ts", "src/b.ts"]);
    if (edit.effect !== "ask") throw new Error("expected an ask");
    expect(edit.event.kind).toBe("workspace-write");
    expect(edit.event.nativeAction?.resources).toEqual(["src/a.ts", "src/b.ts"]);
    const { nativeAction: _n2, type: _t2, ...editProjected } = edit.event;
    expect(validateCodingWorkbenchPermissionRequest(editProjected)).toMatchObject({ ok: true });
  });
});

describe("native policy evidence", () => {
  function captureActivityLog(): {
    readonly activityLog: ServerLogSink;
    readonly records: ServerLogEvent[];
  } {
    const records: ServerLogEvent[] = [];
    return { activityLog: { write: (event) => void records.push(event) }, records };
  }

  it("records every decision body-free with the closed action and outcome vocabulary", () => {
    const captured = captureActivityLog();
    const denied = decide("supervised-coding", "shell", ["git push origin HEAD"]);
    recordOpenCodeNativePolicyDecision(captured.activityLog, "run-native-1", {
      mode: "supervised-coding",
      request: request("shell", ["git push origin HEAD"]),
      decision: denied,
      outcome: "delivery-reserved",
    });
    const asked = decide("governed-assist", "edit", ["src/secret-doc.ts"]);
    recordOpenCodeNativePolicyDecision(captured.activityLog, "run-native-1", {
      mode: "governed-assist",
      request: request("edit", ["src/secret-doc.ts"]),
      decision: asked,
      outcome: "approved",
    });
    recordOpenCodeNativePolicyDecision(captured.activityLog, "run-native-1", {
      mode: "autonomous-delivery",
      request: request("teleport", []),
      decision: decide("autonomous-delivery", "teleport", []),
      outcome: "unsupported-action",
    });
    // The pinned producer's plan tool asks as `todowrite`; the line names it in the closed vocabulary.
    recordOpenCodeNativePolicyDecision(captured.activityLog, "run-native-1", {
      mode: "governed-assist",
      request: request("todowrite", ["*"]),
      decision: decide("governed-assist", "todowrite", ["*"]),
      outcome: "allowed",
    });
    expect(captured.records).toHaveLength(4);
    const [first, second, third, fourth] = captured.records;
    if (first === undefined || second === undefined || third === undefined || fourth === undefined)
      throw new Error("log");
    expect(
      expectActivityLogProof(
        "coding-runtime.native-policy.decided.emitted-line",
        formatActivityLogProofLine(first),
      ),
    ).toMatchObject({
      mode: "supervised-coding",
      permission: "shell",
      effect: "deny",
      outcome: "delivery-reserved",
      resourceCount: 1,
    });
    expect(first.level).toBe("warn");
    expect(
      expectActivityLogProof(
        "coding-runtime.native-policy.decided.emitted-line",
        formatActivityLogProofLine(second),
      ),
    ).toMatchObject({ permission: "edit", effect: "ask", outcome: "approved" });
    expect(
      expectActivityLogProof(
        "coding-runtime.native-policy.decided.emitted-line",
        formatActivityLogProofLine(third),
      ),
    ).toMatchObject({ permission: "other", effect: "deny", outcome: "unsupported-action" });
    expect(
      expectActivityLogProof(
        "coding-runtime.native-policy.decided.emitted-line",
        formatActivityLogProofLine(fourth),
      ),
    ).toMatchObject({ permission: "todowrite", effect: "allow", outcome: "allowed" });
    const serialized = JSON.stringify(captured.records);
    expect(serialized).not.toContain("git push");
    expect(serialized).not.toContain("example.com");
  });
});

describe("native authority evidence (#3897 review)", () => {
  it("names a refusal reason in closed words, every binding drift as one", () => {
    for (const reason of [
      "authority-budget-exceeded",
      "authority-expired",
      "revoked",
      "authority-resolution-failed",
      "action-not-authorized",
      "unavailable",
      "patch-too-large",
    ])
      expect(nativeAuthorityReasonLogValue(reason)).toBe(reason);
    for (const drift of ["workspace-drift", "task-drift", "branch-drift", "budget-drift"])
      expect(nativeAuthorityReasonLogValue(drift)).toBe("drift");
    expect(nativeAuthorityReasonLogValue("PRIVATE_/path/to/secret")).toBe("other");
    expect(nativeAuthorityReasonLogValue("authority-replayed")).toBe("other");
  });

  // Needs the regenerated operation catalog: the proof validates the persisted line against the
  // generated registry, which declares `invocationCharge` and `authorityReason` once regenerated.
  it("records how a check was charged and why the authority refused one, body-free", () => {
    const records: ServerLogEvent[] = [];
    const sink: ServerLogSink = { write: (event) => void records.push(event) };
    const allowed = decide("supervised-coding", "read", ["src/index.ts"]);
    recordOpenCodeNativePolicyDecision(sink, "run-native-1", {
      mode: "supervised-coding",
      request: request("read", ["src/index.ts"]),
      decision: allowed,
      outcome: "allowed",
      sessionRelation: "child",
      authority: { charge: "already-charged" },
    });
    recordOpenCodeNativePolicyDecision(sink, "run-native-1", {
      mode: "supervised-coding",
      request: request("read", ["src/index.ts"]),
      decision: allowed,
      outcome: "authority-refused",
      authority: { reason: "authority-budget-exceeded" },
    });
    const [charged, refused] = records;
    if (charged === undefined || refused === undefined) throw new Error("log");
    expect(
      expectActivityLogProof(
        "coding-runtime.native-policy.decided.emitted-line",
        formatActivityLogProofLine(charged),
      ),
    ).toMatchObject({ outcome: "allowed", invocationCharge: "already-charged" });
    const refusedLine = expectActivityLogProof(
      "coding-runtime.native-policy.decided.emitted-line",
      formatActivityLogProofLine(refused),
    );
    expect(refusedLine).toMatchObject({
      outcome: "authority-refused",
      authorityReason: "authority-budget-exceeded",
    });
    expect(refusedLine).not.toHaveProperty("invocationCharge");
    expect(JSON.stringify(records)).not.toContain("src/index.ts");
  });
});

describe("Code Mode management tools (#3897, #3903 AC4)", () => {
  const MODES = ["governed-assist", "supervised-coding", "autonomous-delivery"] as const;
  const OWN = "ses_native0000000000001";

  // A new worktree is a new branch of the repository: the human decides it in every mode, Full
  // access included, and an approved one is provisioned by the managed owner, never by the
  // producer (the composition blocks the producer's own call after the decision).
  it("asks the human before a new managed task workspace in every mode", () => {
    for (const mode of MODES) {
      const decision = decide(mode, "opencode_worktree_create", ["feature-x.2_b"]);
      expect(decision.effect, mode).toBe("ask");
      expect(decision.classification).toMatchObject({
        actionClass: "workspace-write",
        scope: "delivery",
        risk: "high",
      });
    }
  });

  it("refuses a worktree without one plain name", () => {
    for (const mode of MODES)
      for (const resources of [
        [],
        ["a", "b"],
        ["../x"],
        [".hidden"],
        ["with space"],
        ["x".repeat(65)],
      ])
        expect(effectOf(mode, "opencode_worktree_create", resources), resources.join()).toBe(
          "deny:unsupported-action",
        );
  });

  // A real workspace: a move is decided against the directory the session would land in.
  function moveFixture(): { readonly root: string; readonly workspace: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-session-move-")));
    const workspace = join(root, "workspace");
    mkdirSync(join(workspace, "src", "deep"), { recursive: true });
    mkdirSync(join(root, "outside"));
    // A junction on Windows (no privilege needed), a directory symlink elsewhere (#4068).
    plantDirectoryRedirect(join(root, "outside"), join(workspace, "escape"));
    writeFileSync(join(workspace, "file.txt"), "x");
    return { root, workspace };
  }

  function moveEffect(
    workspace: string,
    mode: string,
    resources: readonly string[],
    overrides: Partial<OpenCodeNativePolicyRequest> = {},
  ): string {
    const decision = decideOpenCodeNativePolicy({
      mode,
      workspaceRoot: workspace,
      request: request("opencode_session_move", resources, overrides),
      nowMs: NOW,
    });
    return decision.effect === "deny" ? `deny:${decision.reason}` : decision.effect;
  }

  it("lets the run's own session move to a directory inside the workspace, in every mode", () => {
    const { root, workspace } = moveFixture();
    try {
      for (const mode of MODES) {
        expect(moveEffect(workspace, mode, [join(workspace, "src")]), mode).toBe("allow");
        expect(
          moveEffect(workspace, mode, [join(workspace, "src", "deep")], { targetSessionID: OWN }),
        ).toBe("allow");
        // Back to the root is a move inside the workspace too.
        expect(moveEffect(workspace, mode, [workspace])).toBe("allow");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses another session, another place, a link, a file and a missing directory", () => {
    const { root, workspace } = moveFixture();
    const src = join(workspace, "src");
    try {
      const cases: readonly [readonly string[], Partial<OpenCodeNativePolicyRequest>, string][] = [
        [[src], { targetSessionID: "ses_other0000000000001" }, "deny:unsupported-action"],
        [[join(root, "outside")], {}, "deny:workspace-escape"],
        [[join(workspace, "escape")], {}, "deny:workspace-escape"],
        [[join(workspace, "file.txt")], {}, "deny:workspace-escape"],
        [[join(workspace, "gone")], {}, "deny:workspace-escape"],
        [["src"], {}, "deny:unsupported-action"],
        [[`${src}/../src`], {}, "deny:unsupported-action"],
        [[`${src}/`], {}, "deny:unsupported-action"],
        [[], {}, "deny:unsupported-action"],
        [[src, workspace], {}, "deny:unsupported-action"],
      ];
      for (const mode of MODES)
        for (const [resources, overrides, expected] of cases)
          expect(
            moveEffect(workspace, mode, resources, overrides),
            `${mode} ${resources.join()}`,
          ).toBe(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records a move's decision under its own closed action name, never the directory", () => {
    const { root, workspace } = moveFixture();
    try {
      const records: ServerLogEvent[] = [];
      const sink: ServerLogSink = { write: (event) => void records.push(event) };
      for (const [resources, outcome] of [
        [[join(workspace, "src")], "allowed"],
        [[join(root, "outside")], "workspace-escape"],
      ] as const) {
        const moved = request("opencode_session_move", resources);
        recordOpenCodeNativePolicyDecision(sink, "run-native-1", {
          mode: "autonomous-delivery",
          request: moved,
          decision: decideOpenCodeNativePolicy({
            mode: "autonomous-delivery",
            workspaceRoot: workspace,
            request: moved,
            nowMs: NOW,
          }),
          outcome,
        });
      }
      const [allowed, refused] = records.map((record) =>
        expectActivityLogProof(
          "coding-runtime.native-policy.decided.emitted-line",
          formatActivityLogProofLine(record),
        ),
      );
      expect(allowed).toMatchObject({ permission: "opencode_session_move", effect: "allow" });
      expect(refused).toMatchObject({
        permission: "opencode_session_move",
        effect: "deny",
        outcome: "workspace-escape",
      });
      expect(JSON.stringify(records)).not.toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses the session a move names and refuses a malformed one", () => {
    const body = {
      action: "native-policy",
      runId: "run-1",
      sessionID: OWN,
      permission: "opencode_session_move",
      resources: ["/workspace/src"],
    };
    expect(parseOpenCodeNativePolicyRequest({ ...body, targetSessionID: null })).not.toHaveProperty(
      "targetSessionID",
    );
    expect(parseOpenCodeNativePolicyRequest({ ...body, targetSessionID: OWN })).toMatchObject({
      targetSessionID: OWN,
    });
    for (const malformed of [42, "", "not-a-session", { id: OWN }])
      expect(
        parseOpenCodeNativePolicyRequest({ ...body, targetSessionID: malformed }),
      ).toBeUndefined();
  });
});

describe("plan agent notes in the run-private plan directory (#3897)", () => {
  const PLAN = "/state/run-1/home/.opencode/plan";
  const decideWithPlan = (
    mode: string,
    permission: string,
    resources: readonly string[],
    planRoot: string | null = PLAN,
  ): string => {
    const decision = decideOpenCodeNativePolicy({
      mode,
      workspaceRoot: WORKSPACE,
      ...(planRoot === null ? {} : { planRoot }),
      request: request(permission, resources),
      nowMs: 0,
    });
    return decision.effect === "deny" ? `deny:${decision.reason}` : decision.effect;
  };

  it("admits reading and writing the plan without asking in every mode", () => {
    for (const mode of ["governed-assist", "supervised-coding", "autonomous-delivery"]) {
      expect(decideWithPlan(mode, "external_directory", [`${PLAN}/*`])).toBe("allow");
      expect(decideWithPlan(mode, "edit", [`${PLAN}/feature.md`])).toBe("allow");
      expect(decideWithPlan(mode, "read", [`${PLAN}/feature.md`])).toBe("allow");
    }
  });

  it("keeps every other external path refused and the workspace rules unchanged", () => {
    expect(decideWithPlan("autonomous-delivery", "external_directory", ["/etc/*"])).toBe(
      "deny:workspace-escape",
    );
    expect(decideWithPlan("autonomous-delivery", "edit", [`${PLAN}/../escape.md`])).toBe(
      "deny:workspace-escape",
    );
    expect(decideWithPlan("autonomous-delivery", "read", [`${PLAN}/.env`])).toBe(
      "deny:sensitive-path",
    );
    expect(decideWithPlan("governed-assist", "edit", ["src/a.ts"])).toBe("ask");
    expect(decideWithPlan("supervised-coding", "edit", [`${PLAN}/feature.md`, "src/a.ts"])).toBe(
      "allow",
    );
    expect(decideWithPlan("governed-assist", "edit", [`${PLAN}/feature.md`, "src/a.ts"])).toBe(
      "ask",
    );
    expect(decideWithPlan("autonomous-delivery", "external_directory", [`${PLAN}/*`], null)).toBe(
      "deny:workspace-escape",
    );
  });

  // #3897 review: a note path that resolves outside the plan directory (a symbolic link, a hard
  // link or a replaced ancestor naming a workspace file) is an ordinary edit, not a private note.
  // Each link form plants its own tree, so a host that cannot create a file symlink still runs the
  // hard-link and directory-link controls (#4068).
  function withPlan(body: (root: string, plan: string, workspaceFile: string) => void): void {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-plan-note-")));
    try {
      const plan = join(root, "run-1", "home", ".opencode", "plan");
      mkdirSync(plan, { recursive: true });
      const workspaceFile = join(root, "README.md");
      writeFileSync(workspaceFile, "readme");
      writeFileSync(join(plan, "note.md"), "note");
      body(root, plan, workspaceFile);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const askNote = (plan: string, resource: string): string =>
    decideWithPlan("governed-assist", "edit", [resource], plan);

  it("exempts only notes that are physically inside the plan directory", () => {
    withPlan((_root, plan, workspaceFile) => {
      linkSync(workspaceFile, join(plan, "hard.md"));
      expect(askNote(plan, join(plan, "note.md"))).toBe("allow");
      expect(askNote(plan, join(plan, "new.md"))).toBe("allow");
      expect(askNote(plan, join(plan, "hard.md"))).toBe("ask");
    });
  });

  it("asks for a note that is a symbolic link to a workspace file", (testContext) => {
    withPlan((_root, plan, workspaceFile) => {
      plantSymlinkOrSkip(testContext, workspaceFile, join(plan, "link.md"));
      expect(askNote(plan, join(plan, "link.md"))).toBe("ask");
    });
  });

  it("asks for a note reached through a directory link out of the plan directory", () => {
    withPlan((root, plan) => {
      plantDirectoryRedirect(root, join(plan, "linked"));
      expect(askNote(plan, join(plan, "linked", "README.md"))).toBe("ask");
    });
  });

  it("asks once an ancestor of the plan directory is replaced by a link into another tree", () => {
    withPlan((root, plan) => {
      const elsewhere = join(root, "elsewhere", ".opencode");
      mkdirSync(join(elsewhere, "plan"), { recursive: true });
      rmSync(join(root, "run-1", "home", ".opencode"), { recursive: true });
      plantDirectoryRedirect(elsewhere, join(root, "run-1", "home", ".opencode"));
      expect(askNote(plan, join(plan, "note.md"))).toBe("ask");
    });
  });
});

// PR #4064 review: a hard link inside the workspace can name a protected file or one outside it,
// and the producer's read tool loads every AGENTS.md it passes without asking.
describe("hard links inside the workspace (PR #4064 review)", () => {
  const MODES = ["governed-assist", "supervised-coding", "autonomous-delivery"];

  function withWorkspace(body: (workspace: string, outside: string) => void): void {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-links-")));
    try {
      const workspace = join(root, "workspace");
      mkdirSync(join(workspace, "src", "nested"), { recursive: true });
      writeFileSync(join(workspace, "src", "file.ts"), "export {};\n");
      writeFileSync(join(workspace, "src", "nested", "deep.ts"), "export {};\n");
      const outside = join(root, "outside.txt");
      writeFileSync(outside, "OUTSIDE-CANARY\n");
      body(workspace, outside);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  function verdict(
    workspace: string,
    mode: string,
    permission: string,
    resources: readonly string[],
  ): string {
    const decision = decideOpenCodeNativePolicy({
      mode,
      workspaceRoot: workspace,
      request: request(permission, resources),
      nowMs: NOW,
    });
    return decision.effect === "deny" ? `deny:${decision.reason}` : decision.effect;
  }

  it("refuses to read or edit a file that is a hard link, in every mode", () => {
    withWorkspace((workspace, outside) => {
      linkSync(outside, join(workspace, "alias.txt"));
      for (const mode of MODES) {
        // The producer asks `edit` for its edit, write and patch tools alike.
        for (const permission of ["read", "edit"]) {
          expect(verdict(workspace, mode, permission, ["alias.txt"])).toBe("deny:linked-file");
          expect(verdict(workspace, mode, permission, [join(workspace, "alias.txt")])).toBe(
            "deny:linked-file",
          );
        }
      }
    });
  });

  it("refuses a read that would load an AGENTS.md that is a hard link", () => {
    withWorkspace((workspace, outside) => {
      linkSync(outside, join(workspace, "src", "AGENTS.md"));
      for (const mode of MODES) {
        expect(verdict(workspace, mode, "read", ["src/file.ts"])).toBe("deny:linked-file");
        expect(verdict(workspace, mode, "read", ["src/nested/deep.ts"])).toBe("deny:linked-file");
        expect(verdict(workspace, mode, "read", ["src"])).toBe("deny:linked-file");
      }
      // An edit loads no instructions, and a read beside the linked file does not pass it.
      expect(verdict(workspace, "autonomous-delivery", "edit", ["src/file.ts"])).toBe("allow");
      writeFileSync(join(workspace, "top.ts"), "export {};\n");
      expect(verdict(workspace, "autonomous-delivery", "read", ["top.ts"])).toBe("allow");
    });
  });

  it("refuses a read anywhere under a root AGENTS.md that is a hard link", () => {
    withWorkspace((workspace, outside) => {
      linkSync(outside, join(workspace, "AGENTS.md"));
      expect(verdict(workspace, "autonomous-delivery", "read", ["src/nested/deep.ts"])).toBe(
        "deny:linked-file",
      );
      expect(verdict(workspace, "autonomous-delivery", "read", ["."])).toBe("deny:linked-file");
    });
  });

  it("keeps ordinary files, regular AGENTS.md files and new files admitted", () => {
    withWorkspace((workspace) => {
      writeFileSync(join(workspace, "src", "AGENTS.md"), "# rules\n");
      writeFileSync(join(workspace, "AGENTS.md"), "# root rules\n");
      for (const mode of MODES) {
        expect(verdict(workspace, mode, "read", ["src/file.ts"])).toBe("allow");
        expect(verdict(workspace, mode, "read", ["src/AGENTS.md"])).toBe("allow");
        expect(verdict(workspace, mode, "read", ["."])).toBe("allow");
        expect(verdict(workspace, mode, "read", ["src/file.ts/below-a-file"])).toBe("allow");
      }
      expect(verdict(workspace, "autonomous-delivery", "edit", ["src/new.ts"])).toBe("allow");
      expect(verdict(workspace, "autonomous-delivery", "edit", ["src/file.ts"])).toBe("allow");
    });
  });
});

// #3901: a native shell line is verification evidence only when its one exit status can speak for
// the check alone: every simple command is a project check or a `cd`.
describe("native verification commands (#3901, #3897 review)", () => {
  it.each([
    [["npm test"], "test"],
    [["npm run test:unit -- --reporter=dot"], "test"],
    [["pnpm run typecheck"], "typecheck"],
    [["yarn run lint --fix"], "lint"],
    [["npm run build"], "build"],
    [["npx vitest run src/a.test.ts"], "test"],
    [["npx tsc --noEmit"], "typecheck"],
    [["npx eslint ."], "lint"],
    [["cd packages/app", "npm test"], "test"],
    [["env CI=1 npm test"], "test"],
    [["mvn test"], "test"],
    [["./gradlew build"], "build"],
    [["cargo clippy"], "lint"],
    [["go vet ./..."], "lint"],
    [["pytest -q"], "test"],
    [["python3 -m pytest tests"], "test"],
    [["node --test"], "test"],
    [["cd packages/app && npm test"], "test"],
    [["npm run lint && npm test"], "lint"],
    [["npm test 2>&1"], "test"],
  ] as const)("classifies %j as a %s check", (resources, kind) => {
    expect(openCodeNativeVerificationKind(resources)).toBe(kind);
  });

  it.each([
    [[]],
    [["cd packages/app"]],
    [["npm test", "true"]],
    [["npm test | tee test.log"]],
    [["npm test; rm -rf dist"]],
    [["npm install"]],
    [["npm run deploy"]],
    [["git status"]],
    [["rm -rf node_modules"]],
    [["bash -c 'npm test'"]],
    // #3897 review: another command decides the line's exit status after a failed check.
    [["npm test; cd ."]],
    [["npm test || cd ."]],
    [["npm test | cat"]],
    [["npm test &"]],
    [["npm test & npm run lint"]],
    [["npm test\ncd ."]],
    [["npm test && "]],
    [["npm test &>log"]],
  ] as const)("does not count %j as verification", (resources) => {
    expect(openCodeNativeVerificationKind(resources)).toBeUndefined();
  });

  // #3901: a check that only prints, lists or plans exits zero without checking anything.
  it.each([
    [["npx vitest --version"]],
    [["npx vitest --help"]],
    [["npx vitest --help=true"]],
    [["npx vitest --version=true"]],
    [["npx vitest list"]],
    [["npx tsc -h"]],
    [["npx tsc --showConfig"]],
    [["npx eslint --print-config src/a.ts"]],
    [["npx jest --listTests"]],
    [["npx jest --listTests=true"]],
    [["npm test -- --listTests"]],
    [["npx playwright test --list"]],
    [["pytest --collect-only"]],
    [["python3 -m pytest --co tests"]],
    [["go test -list ."]],
    [["go test -list=. ./..."]],
    [["cargo test --no-run"]],
    [["make -n test"]],
    [["make -Bn test"]],
    [["make -nB test"]],
    [["make -eBn test"]],
    [["make test -Bq"]],
    [["make test -qB"]],
    [["make test -Bh"]],
    [["make test -Bv"]],
    [["make test -Bt"]],
    [["make test --touch"]],
    [["make -q check"]],
    [["./gradlew build -m"]],
    [["./gradlew build -qm"]],
    [["gradle -mq build"]],
    [["gradlew build --task-graph"]],
    [["gradle build -qv"]],
    [["npm run build -- --dry-run"]],
    [["cd packages/app && npx vitest --version"]],
  ] as const)("does not count the non-executing check %j as verification", (resources) => {
    expect(openCodeNativeVerificationKind(resources)).toBeUndefined();
  });

  it.each([
    [["pytest -v"], "test"],
    [["go test -v ./..."], "test"],
    [["go test -run=X ./..."], "test"],
    [["npx vitest run --reporter=verbose"], "test"],
    [["make test"], "test"],
    // Option operands may contain n/q/h: they are not combined switches.
    [["make -B test"], "test"],
    [["make test -fquiet"], "test"],
    [["make test -Cbench"], "test"],
    [["make test -Iheaders"], "test"],
    [["./gradlew build -Dname=value"], "build"],
    [["npm test -- --coverage"], "test"],
  ] as const)("still counts the executing check %j", (resources, kind) => {
    expect(openCodeNativeVerificationKind(resources)).toBe(kind);
  });
});

// Keiko 1.3.1 qualification (T4, Ask for approval): the lab repository's AGENTS.md says "run `npm
// run check`", the model did, and it passed; the run still failed as unverified, because the line
// counted as a test alone and the type check and lint it ran stayed unproven.
describe("checks a passing line also proves (Keiko 1.3.1 qualification)", () => {
  const LAB_SCRIPTS = new Map([
    ["test", "node --test"],
    ["typecheck", "tsc --noEmit"],
    ["lint", "eslint ."],
    ["check", "npm run typecheck && npm run lint && npm test"],
    ["start", "node src/cli.ts"],
  ]);
  const scripts =
    (map: ReadonlyMap<string, string> = LAB_SCRIPTS) =>
    (): ReadonlyMap<string, string> =>
      map;

  it("credits every check the lab repository's `npm run check` chains", () => {
    expect(openCodeNativeVerificationKind(["npm run check"])).toBe("test");
    expect(openCodeNativeCreditedKinds(["npm run check"], scripts())).toEqual([
      "typecheck",
      "lint",
    ]);
  });

  it("credits each check of an && line the model typed itself, without reading any script", () => {
    const read = vi.fn(scripts());
    expect(openCodeNativeCreditedKinds(["npm run typecheck", "npm run lint", "npm test"])).toEqual([
      "lint",
      "test",
    ]);
    expect(openCodeNativeCreditedKinds(["npx tsc --noEmit", "npx eslint ."], read)).toEqual([
      "lint",
    ]);
    expect(read).not.toHaveBeenCalled();
  });

  it("reads the package scripts at most once per line", () => {
    const read = vi.fn(scripts());
    openCodeNativeCreditedKinds(["npm run check", "npm run typecheck"], read);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    // Not a check line at all: nothing is credited, and no script is read.
    [["ls -la"]],
    [["npm run check", "true"]],
    [["npm run start"]],
    // A line that changes directory runs another package's scripts.
    [["cd packages/app", "npm run check"]],
    // Options that can point the manager at another package, or a non-executing check.
    [["npm run check --workspace=web"]],
    [["npm --prefix web run check"]],
    [["npm run --silent check"]],
    [["npm run check -- --help"]],
    // Bun's own test runner is no script.
    [["bun test"]],
  ] as const)("credits nothing more for %j", (resources) => {
    expect(openCodeNativeCreditedKinds(resources, scripts())).toEqual([]);
  });

  it("credits nothing from a script body another operator could hand its status to", () => {
    const masked = new Map([
      ["check", "npm run typecheck; npm run lint || true"],
      ["typecheck", "tsc --noEmit"],
      ["lint", "eslint ."],
    ]);
    expect(openCodeNativeCreditedKinds(["npm run check"], scripts(masked))).toEqual([]);
  });

  it("credits the checks of a body beside other commands, and only by name after a cd", () => {
    const mixed = new Map([
      ["check", "npm run format && tsc --noEmit && cd web && npm run lint"],
      ["format", "prettier --check ."],
      ["lint", "vitest run"],
    ]);
    // `npm run lint` after `cd web` runs web's own lint script, which this package.json does not
    // describe: it is credited as the lint its name says, not as this package's `vitest run`.
    expect(openCodeNativeCreditedKinds(["npm run check"], scripts(mixed))).toEqual([
      "typecheck",
      "lint",
    ]);
  });

  it("stops at a bounded depth, so scripts that run each other terminate", () => {
    const cyclic = new Map([
      ["check", "npm run verify && npm run lint"],
      ["verify", "npm run check"],
      ["lint", "eslint ."],
    ]);
    expect(openCodeNativeCreditedKinds(["npm run check"], scripts(cyclic))).toEqual(["lint"]);
  });

  it("credits a line whose script table is unreadable by its own checks alone", () => {
    expect(openCodeNativeCreditedKinds(["npm run check"], () => undefined)).toEqual([]);
    expect(openCodeNativeCreditedKinds(["npm run check"])).toEqual([]);
  });
});

// Program names are untrusted model text: one that names an `Object.prototype` member must be an
// ordinary unvetted command, never a lookup that reaches the prototype and throws.
describe("program names that collide with prototype members", () => {
  it.each(["constructor test", "__proto__ build", "hasOwnProperty x", "toString"])(
    "classifies %j as an ordinary command and as no check",
    (command) => {
      expect(effectOf("supervised-coding", "shell", [command])).toBe("ask");
      expect(effectOf("autonomous-delivery", "shell", [command])).toBe("allow");
      expect(openCodeNativeVerificationKind([command])).toBeUndefined();
    },
  );
});

// #3903 (parity row C04): an MCP tool is callable only when the operator's registry names it. Its
// declared risk and transport choose the action class; everything else stays unsupported.
describe("MCP tools under the operator's registry (#3903)", () => {
  const admission = openCodeNativeMcpAdmission({
    servers: [
      {
        name: "docs",
        description: undefined,
        enabled: true,
        transport: { kind: "local", command: ["/opt/docs-mcp"], environment: {} },
        tools: { search: "read", "page.update": "write" },
      },
      {
        name: "tracker",
        description: undefined,
        enabled: true,
        transport: { kind: "remote", url: "https://tracker.example.test/mcp" },
        tools: { find: "read" },
      },
    ],
    mode: "autonomous-delivery",
    home: "/tmp/keiko-native-policy/home",
  });
  const mcpEffect = (mode: string, permission: string, resources: readonly string[]): string => {
    const decision = decideOpenCodeNativePolicy({
      mode,
      workspaceRoot: WORKSPACE,
      request: request(permission, resources),
      nowMs: NOW,
      mcp: admission.grants,
    });
    return decision.effect === "deny" ? `deny:${decision.reason}` : decision.effect;
  };

  it.each([
    ["docs_search", ["*"], ["ask", "allow", "allow"]],
    ["docs_page_update", ["*"], ["ask", "ask", "allow"]],
    ["tracker_find", ["*"], ["deny:mode-denied", "deny:mode-denied", "allow"]],
    ["opencode_list_mcp_resources", ["docs"], ["ask", "allow", "allow"]],
    ["opencode_read_mcp_resource", ["docs:docs://note"], ["ask", "allow", "allow"]],
    [
      "opencode_list_mcp_resources",
      ["docs", "tracker"],
      ["deny:mode-denied", "deny:mode-denied", "allow"],
    ],
  ] as const)("classifies %s %j by mode", (permission, resources, effects) => {
    expect(
      ["governed-assist", "supervised-coding", "autonomous-delivery"].map((mode) =>
        mcpEffect(mode, permission, resources),
      ),
    ).toEqual(effects);
  });

  it.each([
    ["docs_delete", ["*"]],
    ["other_search", ["*"]],
    ["opencode_list_mcp_resources", ["other"]],
    ["opencode_list_mcp_resources", []],
    ["opencode_read_mcp_resource", ["other:x://y"]],
  ] as const)("keeps %s %j unsupported", (permission, resources) => {
    for (const mode of ["governed-assist", "supervised-coding", "autonomous-delivery"])
      expect(mcpEffect(mode, permission, resources)).toBe("deny:unsupported-action");
  });

  it("refuses every MCP tool when no registry grants are given", () => {
    expect(effectOf("autonomous-delivery", "docs_search", ["*"])).toBe("deny:unsupported-action");
  });

  it("logs an MCP tool by its class, never by its server or tool name", () => {
    const records: ServerLogEvent[] = [];
    const decision = decideOpenCodeNativePolicy({
      mode: "autonomous-delivery",
      workspaceRoot: WORKSPACE,
      request: request("docs_search", ["*"]),
      nowMs: NOW,
      mcp: admission.grants,
    });
    recordOpenCodeNativePolicyDecision(
      { write: (event) => void records.push(event) },
      "run-native-1",
      {
        mode: "autonomous-delivery",
        request: request("docs_search", ["*"]),
        decision,
        outcome: "allowed",
      },
    );
    expect(records[0]?.extra).toMatchObject({ permission: "mcp", effect: "allow" });
    expect(JSON.stringify(records[0])).not.toContain("docs");
  });
});

// #3900 AC5: a directory the operator accepted as an external reference is read-only; each read is
// an `external-file` action of the run's mode, and the workspace's sensitive-path and hard-link
// refusals hold inside it.
describe("accepted external references (#3900 AC5)", () => {
  function external(): {
    readonly root: string;
    readonly reference: string;
    readonly workspace: string;
  } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-external-")));
    const reference = join(root, "reference", "docs");
    const workspace = join(root, "workspace");
    mkdirSync(reference, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(reference, "guide.md"), "guide\n");
    writeFileSync(join(reference, ".env"), "TOKEN=x\n");
    writeFileSync(join(root, "outside.txt"), "outside\n");
    linkSync(join(root, "outside.txt"), join(reference, "linked.txt"));
    return { root, reference, workspace };
  }

  function effect(
    paths: { readonly reference: string; readonly workspace: string },
    mode: string,
    permission: string,
    resources: readonly string[],
    overrides: Partial<OpenCodeNativePolicyRequest> = {},
    externalRoots: readonly string[] = [paths.reference],
  ): string {
    const decision = decideOpenCodeNativePolicy({
      mode,
      workspaceRoot: paths.workspace,
      externalRoots,
      request: request(permission, resources, overrides),
      nowMs: NOW,
    });
    return decision.effect === "deny" ? `deny:${decision.reason}` : decision.effect;
  }

  it("asks before an external read below Full access and allows it in Full access", () => {
    const paths = external();
    try {
      const guide = join(paths.reference, "guide.md");
      for (const [mode, expected] of [
        ["governed-assist", "ask"],
        ["supervised-coding", "ask"],
        ["autonomous-delivery", "allow"],
      ] as const) {
        expect(effect(paths, mode, "external_directory", [`${paths.reference}/*`]), mode).toBe(
          expected,
        );
        expect(effect(paths, mode, "read", [guide]), mode).toBe(expected);
        expect(effect(paths, mode, "grep", ["needle"], { searchPath: paths.reference }), mode).toBe(
          expected,
        );
      }
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it("never writes there, and refuses its credential files, hard links and every other directory", () => {
    const paths = external();
    try {
      for (const mode of ["governed-assist", "supervised-coding", "autonomous-delivery"]) {
        expect(effect(paths, mode, "edit", [join(paths.reference, "guide.md")])).toBe(
          "deny:workspace-escape",
        );
        expect(effect(paths, mode, "read", [join(paths.reference, ".env")])).toBe(
          "deny:sensitive-path",
        );
        expect(effect(paths, mode, "read", [join(paths.reference, "linked.txt")])).toBe(
          "deny:linked-file",
        );
        expect(effect(paths, mode, "read", [join(paths.root, "outside.txt")])).toBe(
          "deny:workspace-escape",
        );
        expect(effect(paths, mode, "external_directory", [`${paths.root}/*`])).toBe(
          "deny:workspace-escape",
        );
        // Without an accepted reference the same read is outside the workspace.
        expect(effect(paths, mode, "read", [join(paths.reference, "guide.md")], {}, [])).toBe(
          "deny:workspace-escape",
        );
      }
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  });
});

it("asks before managed MCP effects in either restricted mode while retaining direct-network denial", () => {
  const admission = openCodeNativeMcpAdmission({
    servers: [
      {
        name: "managed",
        enabled: true,
        description: undefined,
        transport: { kind: "local", command: ["/synthetic/server"], environment: {} },
        tools: { read: "read", write: "write" },
      },
    ],
    mode: "governed-assist",
    home: "/synthetic/home",
    managed: true,
    relays: new Map([
      ["managed", { url: "http://127.0.0.1:1983/relay", capability: "synthetic-capability" }],
    ]),
  });
  for (const permission of ["managed_read", "managed_write"]) {
    const decisions = ["governed-assist", "supervised-coding", "autonomous-delivery"].map((mode) =>
      decideOpenCodeNativePolicy({
        mode,
        workspaceRoot: WORKSPACE,
        request: request(permission, ["*"]),
        nowMs: NOW,
        mcp: admission.grants,
      }),
    );
    expect(decisions.map((decision) => decision.effect)).toEqual(["ask", "ask", "allow"]);
    expect(decisions[0]).toMatchObject({
      classification: { scope: "internet", label: "native-mcp" },
    });
  }
  const direct = {
    actions: new Map([["direct_read", { risk: "read" as const, remote: true }]]),
    servers: new Map(),
  };
  expect(
    decideOpenCodeNativePolicy({
      mode: "governed-assist",
      workspaceRoot: WORKSPACE,
      request: request("direct_read", ["*"]),
      nowMs: NOW,
      mcp: direct,
    }),
  ).toMatchObject({ effect: "deny", reason: "mode-denied" });
});

describe("a Jira Pod the human chose for the run (owner decision 2026-10-30)", () => {
  const MODES = ["governed-assist", "supervised-coding", "autonomous-delivery"] as const;
  const READS = [
    "jira.projects",
    "jira.issue-types",
    "jira.create-fields",
    "jira.edit-fields",
    "jira.search",
    "jira.issue",
    "jira.comments",
    "jira.transitions",
    "jira.assignable-users",
  ] as const;
  const WRITES = [
    "jira.create",
    "jira.edit",
    "jira.assign",
    "jira.comment",
    "jira.transition",
  ] as const;
  const jira = (
    binding: "bound" | "registry-only",
  ): ReturnType<typeof openCodeNativeMcpAdmission>["grants"] => {
    const definition = codingJiraServerDefinition({
      podId: "0d6c5d3e-7a41-4f0e-9a52-3c1f8e4b7a10",
      authenticationGeneration: 3,
      verificationRevision: 1,
    });
    return openCodeNativeMcpAdmission({
      servers: [definition],
      mode: "governed-assist",
      home: "/synthetic/home",
      managed: true,
      relays: new Map([
        ["jira", { url: "http://127.0.0.1:1983/relay", capability: "synthetic-capability" }],
      ]),
      ...(binding === "bound" ? { grantedServers: new Set(["jira"]) } : {}),
    }).grants;
  };
  const decideTool = (
    grants: ReturnType<typeof jira>,
    mode: (typeof MODES)[number],
    tool: string,
  ): OpenCodeNativePolicyDecision =>
    decideOpenCodeNativePolicy({
      mode,
      workspaceRoot: WORKSPACE,
      request: request(mcpToolAction("jira", tool), ["*"]),
      nowMs: NOW,
      mcp: grants,
    });

  it("allows every Jira read in all three modes without asking", () => {
    const grants = jira("bound");
    for (const tool of READS)
      for (const mode of MODES)
        expect(decideTool(grants, mode, tool).effect, `${mode} ${tool}`).toBe("allow");
  });

  it("lets Jira writes follow the mode: ask below Full access, allowed in Full access", () => {
    const grants = jira("bound");
    for (const tool of WRITES)
      expect(
        MODES.map((mode) => decideTool(grants, mode, tool).effect),
        tool,
      ).toEqual(["ask", "ask", "allow"]);
  });

  it("keeps the classification the approval card and the effect admission already use", () => {
    const grants = jira("bound");
    expect(decideTool(grants, "governed-assist", "jira.issue")).toMatchObject({
      effect: "allow",
      classification: { actionClass: "network-egress", scope: "internet", label: "native-mcp" },
    });
    expect(decideTool(grants, "supervised-coding", "jira.comment")).toMatchObject({
      effect: "ask",
      classification: { actionClass: "network-egress", scope: "internet", label: "native-mcp" },
    });
  });

  it("grants nothing without the human's choice: reads follow the ordinary managed matrix", () => {
    const grants = jira("registry-only");
    for (const tool of [...READS, ...WRITES])
      expect(
        MODES.map((mode) => decideTool(grants, mode, tool).effect),
        tool,
      ).toEqual(["ask", "ask", "allow"]);
  });

  it("admits no Jira tool at all for a run whose Pod was refused or revoked at the start", () => {
    const none = openCodeNativeMcpAdmission({
      servers: [],
      mode: "autonomous-delivery",
      home: "/synthetic/home",
      managed: true,
      relays: new Map(),
      grantedServers: new Set(["jira"]),
    }).grants;
    for (const tool of [...READS, ...WRITES])
      for (const mode of MODES)
        expect(decideTool(none, mode, tool), `${mode} ${tool}`).toMatchObject({
          effect: "deny",
          reason: "unsupported-action",
        });
  });

  it("never grants an action of another server, a resource listing, or an unknown tool", () => {
    const grants = jira("bound");
    for (const mode of MODES) {
      expect(
        decideOpenCodeNativePolicy({
          mode,
          workspaceRoot: WORKSPACE,
          request: request("other_jira_issue", ["*"]),
          nowMs: NOW,
          mcp: grants,
        }),
      ).toMatchObject({ effect: "deny", reason: "unsupported-action" });
      expect(decideTool(grants, mode, "jira.delete-everything")).toMatchObject({
        effect: "deny",
        reason: "unsupported-action",
      });
    }
  });

  it("marks only read tools as run-granted, and never a registry server of the same shape", () => {
    const granted = jira("bound");
    for (const tool of READS)
      expect(granted.actions.get(mcpToolAction("jira", tool))).toMatchObject({
        risk: "read",
        managed: true,
        runGrantedRead: true,
      });
    for (const tool of WRITES)
      expect(granted.actions.get(mcpToolAction("jira", tool))?.runGrantedRead).toBeUndefined();
    for (const tool of READS)
      expect(
        jira("registry-only").actions.get(mcpToolAction("jira", tool))?.runGrantedRead,
      ).toBeUndefined();
  });
});
