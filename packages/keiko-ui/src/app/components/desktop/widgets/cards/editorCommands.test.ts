import { describe, expect, it, vi } from "vitest";
import { EDITOR_VERIFICATION_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";
import {
  EDITOR_PALETTE_COMMANDS,
  availablePaletteCommands,
  fuzzyScore,
  resolveVerificationTarget,
  type EditorPaletteCommand,
  type EditorPaletteHost,
} from "./editorCommands";

function fakeHost(overrides: Partial<EditorPaletteHost> = {}): EditorPaletteHost {
  return {
    root: "/repo",
    activePaneId: "pane-1",
    paneCount: 1,
    activeFile: "src/a.ts",
    closedTabCount: 0,
    dirtyCount: 0,
    verificationRunning: false,
    verifiableTarget: "src/a.test.ts",
    verificationCatalog: {
      schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
      projectId: "/repo",
      kinds: ["test", "targeted-test", "typecheck", "lint", "build"].map((kind) => ({
        kind: kind as "test" | "targeted-test" | "typecheck" | "lint" | "build",
        available: true,
        trustState: "trusted" as const,
      })),
    },
    splitActive: vi.fn(),
    closeActiveSplit: vi.fn(),
    closeActiveTab: vi.fn(),
    nextTab: vi.fn(),
    prevTab: vi.fn(),
    reopenClosed: vi.fn(),
    saveAll: vi.fn(),
    runFileTests: vi.fn(),
    runWorkspaceVerification: vi.fn(),
    cancelVerification: vi.fn(),
    trustWorkspaceScripts: vi.fn(),
    revokeWorkspaceScriptTrust: vi.fn(),
    openProblems: vi.fn(),
    ...overrides,
  };
}

function commandById(id: string): EditorPaletteCommand {
  const command = EDITOR_PALETTE_COMMANDS.find((candidate) => candidate.id === id);
  if (command === undefined) {
    throw new Error(`Missing editor command ${id}`);
  }
  return command;
}

function score(query: string, target: string): number {
  const result = fuzzyScore(query, target);
  if (result === null) {
    throw new Error(`Expected ${query} to match ${target}`);
  }
  return result;
}

describe("editor command registry", () => {
  it("exposes only commands whose host preconditions are satisfied", () => {
    // No active file, no resolvable target: tab/split/save all require an active file, so only the
    // Problems entry and workspace-wide run commands remain.
    const emptyHost = fakeHost({ activeFile: null, verifiableTarget: null });
    expect(availablePaletteCommands(emptyHost).map((command) => command.id)).toEqual([
      "editor.openProblems",
      "run.typecheck",
      "run.lint",
      "run.build",
      "verification.revokeWorkspaceScriptTrust",
    ]);

    const fullHost = fakeHost({ paneCount: 2, closedTabCount: 1, dirtyCount: 1 });
    expect(availablePaletteCommands(fullHost).map((command) => command.id)).toEqual([
      "view.splitRight",
      "view.splitDown",
      "view.closeSplit",
      "tab.next",
      "tab.prev",
      "tab.close",
      "tab.reopenClosed",
      "files.saveAll",
      "editor.openProblems",
      "run.fileTests",
      "run.typecheck",
      "run.lint",
      "run.build",
      "verification.revokeWorkspaceScriptTrust",
    ]);
  });

  it("dispatches commands to the matching editor host actions", () => {
    const host = fakeHost();

    commandById("view.splitRight").run(host);
    commandById("view.splitDown").run(host);
    commandById("view.closeSplit").run(host);
    commandById("tab.next").run(host);
    commandById("tab.prev").run(host);
    commandById("tab.close").run(host);
    commandById("tab.reopenClosed").run(host);
    commandById("files.saveAll").run(host);
    commandById("editor.openProblems").run(host);

    expect(host.splitActive).toHaveBeenNthCalledWith(1, "row");
    expect(host.splitActive).toHaveBeenNthCalledWith(2, "column");
    expect(host.closeActiveSplit).toHaveBeenCalledTimes(1);
    expect(host.nextTab).toHaveBeenCalledTimes(1);
    expect(host.prevTab).toHaveBeenCalledTimes(1);
    expect(host.closeActiveTab).toHaveBeenCalledTimes(1);
    expect(host.reopenClosed).toHaveBeenCalledTimes(1);
    expect(host.saveAll).toHaveBeenCalledTimes(1);
    expect(host.openProblems).toHaveBeenCalledTimes(1);
  });
});

describe("fuzzyScore", () => {
  it("scores empty, boundary, contiguous, and missing matches deterministically", () => {
    expect(fuzzyScore("", "abc")).toBe(3);
    expect(fuzzyScore("zz", "src/SearchPanel.tsx")).toBeNull();
    expect(score("sp", "src/SearchPanel.tsx")).toBeLessThan(score("sp", "workspace/parser.ts"));
    expect(score("FS", "file-search")).toBeLessThan(score("FS", "filesearch"));
  });
});

describe("run affordances (Issue #2212, ADR-0126)", () => {
  it("dispatches each run command to the matching host action with the right kind", () => {
    const host = fakeHost();
    commandById("run.fileTests").run(host);
    commandById("run.typecheck").run(host);
    commandById("run.lint").run(host);
    commandById("run.build").run(host);
    expect(host.runFileTests).toHaveBeenCalledTimes(1);
    expect(host.runWorkspaceVerification).toHaveBeenNthCalledWith(1, "typecheck");
    expect(host.runWorkspaceVerification).toHaveBeenNthCalledWith(2, "lint");
    expect(host.runWorkspaceVerification).toHaveBeenNthCalledWith(3, "build");

    const running = fakeHost({ verificationRunning: true });
    commandById("run.cancel").run(running);
    expect(running.cancelVerification).toHaveBeenCalledTimes(1);
  });

  it("offers run commands only while idle and cancel only while running", () => {
    const idle = fakeHost({ verificationRunning: false });
    const running = fakeHost({ verificationRunning: true });
    const idleIds = availablePaletteCommands(idle).map((c) => c.id);
    const runningIds = availablePaletteCommands(running).map((c) => c.id);
    expect(idleIds).toContain("run.typecheck");
    expect(idleIds).toContain("run.fileTests");
    expect(idleIds).not.toContain("run.cancel");
    expect(runningIds).toContain("run.cancel");
    expect(runningIds).not.toContain("run.typecheck");
    expect(runningIds).not.toContain("run.fileTests");
  });

  it("gates run.fileTests on a resolvable target", () => {
    const noTarget = fakeHost({ verifiableTarget: null });
    expect(availablePaletteCommands(noTarget).map((c) => c.id)).not.toContain("run.fileTests");
    // The workspace-wide kinds do not depend on a target.
    expect(availablePaletteCommands(noTarget).map((c) => c.id)).toContain("run.typecheck");
  });

  it("uses the server catalog and exposes exact trust and revoke commands", () => {
    const approvalRequired = fakeHost({
      verificationCatalog: {
        schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
        projectId: "/repo",
        kinds: [
          { kind: "targeted-test", available: true, trustState: "trusted" },
          { kind: "typecheck", available: true, trustState: "approval-required" },
          { kind: "lint", available: false, trustState: "approval-required" },
          { kind: "build", available: true, trustState: "approval-required" },
        ],
      },
    });
    const commands = availablePaletteCommands(approvalRequired);
    expect(commands.map((command) => command.title)).toContain("Trust Workspace Scripts");
    expect(commands.map((command) => command.title)).not.toContain("Run Typecheck");
    expect(commands.map((command) => command.title)).not.toContain("Run Build");
    expect(commands.map((command) => command.title)).not.toContain("Revoke Workspace Script Trust");
    commandById("verification.trustWorkspaceScripts").run(approvalRequired);
    expect(approvalRequired.trustWorkspaceScripts).toHaveBeenCalledTimes(1);

    const trusted = fakeHost();
    expect(availablePaletteCommands(trusted).map((command) => command.title)).toContain(
      "Revoke Workspace Script Trust",
    );
    commandById("verification.revokeWorkspaceScriptTrust").run(trusted);
    expect(trusted.revokeWorkspaceScriptTrust).toHaveBeenCalledTimes(1);
  });
});

describe("resolveVerificationTarget (Issue #2212)", () => {
  it("maps a source file to its sibling test counterpart", () => {
    expect(resolveVerificationTarget("src/foo.ts")).toBe("src/foo.test.ts");
    expect(resolveVerificationTarget("packages/x/src/bar.tsx")).toBe("packages/x/src/bar.test.tsx");
  });

  it("returns a test file as its own target", () => {
    expect(resolveVerificationTarget("src/foo.test.ts")).toBe("src/foo.test.ts");
    expect(resolveVerificationTarget("src/foo.spec.tsx")).toBe("src/foo.spec.tsx");
  });

  it("returns null for no active file or a non-code extension", () => {
    expect(resolveVerificationTarget(null)).toBeNull();
    expect(resolveVerificationTarget("README.md")).toBeNull();
    expect(resolveVerificationTarget("Makefile")).toBeNull();
  });
});
