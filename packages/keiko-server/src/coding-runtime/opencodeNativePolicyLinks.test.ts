import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";

import {
  decideOpenCodeNativePolicy,
  nativeAuthorityRefusalMessage,
  recordOpenCodeNativePolicyDecision,
  type OpenCodeNativePolicyRequest,
} from "./opencodeNativePolicy.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

/**
 * #4271 A2/A3/A4: a pathname is a hint, not the file. A symbolic link committed to the repository
 * can name `~/.ssh/id_rsa`, `.env` or `.git/hooks/*`; the lexical checks pass it, so the physical
 * location is checked as well. A path the filesystem cannot answer for is a closed refusal on the
 * decision line, never a silently rejected hook request.
 */

const MODES = ["governed-assist", "supervised-coding", "autonomous-delivery"] as const;
const NOW = Date.parse("2026-11-06T12:00:00.000Z");

let root = "";
let workspace = "";
let external = "";
let planRoot = "";

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-symlinks-")));
  workspace = join(root, "workspace");
  external = join(root, "reference");
  mkdirSync(join(workspace, "docs"), { recursive: true });
  mkdirSync(join(workspace, "src", "nested"), { recursive: true });
  mkdirSync(join(workspace, ".git", "hooks"), { recursive: true });
  mkdirSync(join(root, "home", ".ssh"), { recursive: true });
  mkdirSync(join(root, "outside"), { recursive: true });
  mkdirSync(external, { recursive: true });
  writeFileSync(join(root, "home", ".ssh", "id_rsa"), "PRIVATE-KEY-CANARY\n");
  writeFileSync(join(root, "outside", "file.txt"), "OUTSIDE-CANARY\n");
  writeFileSync(join(workspace, ".env"), "SECRET=1\n");
  writeFileSync(join(workspace, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");
  writeFileSync(join(workspace, "src", "real.ts"), "export {};\n");
  writeFileSync(join(external, "ref.md"), "reference\n");
  writeFileSync(join(root, "home", "other.txt"), "other\n");
  // Links a repository can commit.
  symlinkSync("../../home/.ssh/id_rsa", join(workspace, "docs", "notes.md"));
  symlinkSync("../.env", join(workspace, "docs", "env.md"));
  symlinkSync("../.git/hooks/pre-commit", join(workspace, "docs", "hook.md"));
  symlinkSync("../.git/hooks", join(workspace, "docs", "hooks"));
  symlinkSync("../../outside", join(workspace, "docs", "out"));
  symlinkSync("../../outside/missing.txt", join(workspace, "docs", "dangling.md"));
  symlinkSync("../src/real.ts", join(workspace, "docs", "inside.md"));
  symlinkSync("../src", join(workspace, "docs", "src-link"));
  symlinkSync("loop", join(workspace, "docs", "loop"));
  symlinkSync(join(root, "home", "other.txt"), join(external, "escape.md"));
  // An instruction file the read tool loads from every directory it passes.
  symlinkSync("../../../home/other.txt", join(workspace, "src", "nested", "AGENTS.md"));
  planRoot = join(root, "plan");
  mkdirSync(planRoot, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function request(permission: string, resources: readonly string[]): OpenCodeNativePolicyRequest {
  return {
    runId: "run-links-1",
    sessionID: "ses_native0000000000001",
    agent: "build",
    permission,
    resources,
    source: { messageID: "msg_1", id: "call_1" },
  };
}

function verdict(
  mode: string,
  permission: string,
  resources: readonly string[],
  options: { readonly searchPath?: string; readonly externalRoots?: readonly string[] } = {},
): string {
  const decision = decideOpenCodeNativePolicy({
    mode,
    workspaceRoot: workspace,
    ...(options.externalRoots === undefined ? {} : { externalRoots: options.externalRoots }),
    request: {
      ...request(permission, resources),
      ...(options.searchPath === undefined ? {} : { searchPath: options.searchPath }),
    },
    nowMs: NOW,
  });
  return decision.effect === "deny" ? `deny:${decision.reason}` : decision.effect;
}

describe("a symbolic link cannot carry a read or an edit past the path checks (A2)", () => {
  it.each([
    ["docs/notes.md", "deny:workspace-escape"],
    ["docs/env.md", "deny:sensitive-path"],
    ["docs/hook.md", "deny:sensitive-path"],
    ["docs/hooks/pre-commit", "deny:sensitive-path"],
    ["docs/out/file.txt", "deny:workspace-escape"],
    ["docs/out/new-file.txt", "deny:workspace-escape"],
    ["docs/dangling.md", "deny:workspace-escape"],
  ])("refuses %s in every mode for read and edit", (path, expected) => {
    for (const mode of MODES)
      for (const permission of ["read", "edit"])
        expect(verdict(mode, permission, [path]), `${mode} ${permission} ${path}`).toBe(expected);
  });

  it("refuses the absolute spelling of the same path", () => {
    for (const mode of MODES) {
      expect(verdict(mode, "read", [join(workspace, "docs", "notes.md")])).toBe(
        "deny:workspace-escape",
      );
      expect(verdict(mode, "edit", [join(workspace, "docs", "env.md")])).toBe(
        "deny:sensitive-path",
      );
    }
  });

  it("checks the searched directory of glob and grep, and every other resource of a read", () => {
    for (const mode of MODES) {
      expect(
        verdict(mode, "grep", ["secret"], { searchPath: join(workspace, "docs", "out") }),
      ).toBe("deny:workspace-escape");
      expect(verdict(mode, "read", ["src/real.ts", "docs/notes.md"])).toBe("deny:workspace-escape");
    }
  });

  it("keeps links that stay inside the workspace usable", () => {
    for (const permission of ["read", "edit"]) {
      expect(verdict("supervised-coding", permission, ["docs/inside.md"])).toBe("allow");
      expect(verdict("supervised-coding", permission, ["docs/src-link/real.ts"])).toBe("allow");
      expect(verdict("supervised-coding", permission, ["docs/src-link/brand-new.ts"])).toBe(
        "allow",
      );
    }
    expect(verdict("governed-assist", "edit", ["docs/inside.md"])).toBe("ask");
    expect(verdict("supervised-coding", "read", ["src/real.ts", "src/new/dir/file.ts"])).toBe(
      "allow",
    );
  });

  it("refuses an instruction file a read would load through a link that leaves the workspace", () => {
    for (const mode of MODES) {
      expect(verdict(mode, "read", ["src/nested/file.ts"])).toBe("deny:linked-file");
      expect(verdict(mode, "list", ["src/nested"])).toBe("deny:linked-file");
    }
    expect(verdict("supervised-coding", "read", ["src/real.ts"])).toBe("allow");
  });

  it("refuses a link that leaves an accepted external reference", () => {
    const options = { externalRoots: [external] };
    expect(verdict("autonomous-delivery", "read", [join(external, "ref.md")], options)).toBe(
      "allow",
    );
    for (const mode of MODES)
      expect(verdict(mode, "read", [join(external, "escape.md")], options)).toBe(
        "deny:workspace-escape",
      );
  });

  it("keeps a plan note outside the workspace admitted", () => {
    const decision = decideOpenCodeNativePolicy({
      mode: "governed-assist",
      workspaceRoot: workspace,
      planRoot,
      request: request("edit", [join(planRoot, "plan.md")]),
      nowMs: NOW,
    });
    expect(decision.effect).toBe("allow");
  });
});

describe("a path the filesystem cannot answer for is a closed refusal (A3)", () => {
  it.each([
    ["a link loop", "docs/loop"],
    ["a name that is too long", `docs/${"a".repeat(300)}`],
    ["a link loop below a directory", "docs/loop/file.txt"],
  ])("refuses %s in every mode, for read and edit, instead of throwing", (_name, path) => {
    for (const mode of MODES)
      for (const permission of ["read", "edit", "list"])
        expect(verdict(mode, permission, [path]), `${mode} ${permission}`).toBe(
          "deny:path-unresolvable",
        );
  });

  it("states the reason to the model and records it body-free on the decision line", () => {
    const decision = decideOpenCodeNativePolicy({
      mode: "supervised-coding",
      workspaceRoot: workspace,
      request: request("read", ["docs/loop"]),
      nowMs: NOW,
    });
    expect(decision).toMatchObject({
      effect: "deny",
      reason: "path-unresolvable",
      message: expect.stringContaining("cannot be resolved") as string,
    });
    const records: ServerLogEvent[] = [];
    const sink: ServerLogSink = { write: (event) => void records.push(event) };
    recordOpenCodeNativePolicyDecision(sink, "run-links-1", {
      mode: "supervised-coding",
      request: request("read", ["docs/loop"]),
      decision,
      outcome: "path-unresolvable",
    });
    const [line] = records;
    if (line === undefined) throw new Error("log");
    expect(line.level).toBe("warn");
    expect(
      expectActivityLogProof(
        "coding-runtime.native-policy.decided.emitted-line",
        formatActivityLogProofLine(line),
      ),
    ).toMatchObject({
      permission: "read",
      effect: "deny",
      outcome: "path-unresolvable",
      resourceCount: 1,
    });
    expect(JSON.stringify(records)).not.toContain("docs/loop");
  });
});

describe("an authority refusal tells the model what it can do next (A4)", () => {
  it("names a split of the edit when the patch is too large", () => {
    expect(nativeAuthorityRefusalMessage("patch-too-large")).toMatch(/smaller edits/u);
  });

  it("gives each admission reason its own message, and every binding drift one", () => {
    const reasons = [
      "patch-too-large",
      "authority-budget-exceeded",
      "authority-expired",
      "revoked",
      "action-not-authorized",
      "authority-resolution-failed",
      "workspace-drift",
      "unavailable",
      "something-new",
    ];
    const messages = reasons.map((reason) => nativeAuthorityRefusalMessage(reason));
    expect(new Set(messages).size).toBe(reasons.length);
    expect(nativeAuthorityRefusalMessage("run-drift")).toBe(
      nativeAuthorityRefusalMessage("workspace-drift"),
    );
    expect(nativeAuthorityRefusalMessage(undefined)).toBe(
      nativeAuthorityRefusalMessage("something-new"),
    );
    for (const message of messages)
      expect(message.startsWith("Keiko refused this action:")).toBe(true);
  });
});
