import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitCommitMessagePolicyForMode,
  validateGitCommitMessage,
} from "@oscharko-dev/keiko-contracts/runtime/git-commit-policy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UiHandlerDeps } from "../deps.js";
import {
  repositoryDeclaresConventionalCommits,
  resolveGovernedCommitMessagePolicyDecision,
} from "./commitPolicySettings.js";

let root = "";

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-commit-policy-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function controlWith(
  value: string,
  source: "builtInDefault" | "user" | "workspace",
): NonNullable<UiHandlerDeps["editorSettingsControl"]> {
  return {
    read: () => Promise.resolve({ settings: [{ id: "gitCommitMessagePolicy", value, source }] }),
  } as unknown as NonNullable<UiHandlerDeps["editorSettingsControl"]>;
}

const SCRIPTED_MESSAGE = "Rename the modules";

describe("the commit message policy follows the repository (G-4)", () => {
  it("does not impose Conventional Commits on a repository that declares none", async () => {
    const decision = await resolveGovernedCommitMessagePolicyDecision(
      { editorSettingsControl: controlWith("keiko-conventional", "builtInDefault") },
      root,
    );
    expect(decision).toMatchObject({ mode: "repository-native", source: "repository" });
    expect(validateGitCommitMessage(SCRIPTED_MESSAGE, decision.policy)).toEqual({ ok: true });
  });

  it("enforces the convention for a repository with a commitlint configuration", async () => {
    writeFileSync(join(root, "commitlint.config.js"), "export default {};\n");
    const decision = await resolveGovernedCommitMessagePolicyDecision(
      { editorSettingsControl: controlWith("keiko-conventional", "builtInDefault") },
      root,
    );
    expect(decision).toMatchObject({ mode: "keiko-conventional", source: "repository" });
    expect(validateGitCommitMessage(SCRIPTED_MESSAGE, decision.policy)).toEqual({
      ok: false,
      violations: ["missing-conventional-prefix"],
    });
  });

  it.each([
    ["a commitlint key", { commitlint: { extends: [] } }],
    ["a commitlint dependency", { devDependencies: { "@commitlint/cli": "^19.0.0" } }],
  ])("reads %s in package.json as a declared convention", async (_label, manifest) => {
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    expect(await repositoryDeclaresConventionalCommits(root)).toBe(true);
  });

  it("does not read an unrelated package.json as a declared convention", async () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { vitest: "1" } }));
    expect(await repositoryDeclaresConventionalCommits(root)).toBe(false);
  });

  it("lets a person's explicit setting win over the repository", async () => {
    mkdirSync(join(root, "sub"));
    const decision = await resolveGovernedCommitMessagePolicyDecision(
      { editorSettingsControl: controlWith("keiko-conventional", "user") },
      root,
    );
    expect(decision).toMatchObject({ mode: "keiko-conventional", source: "setting" });
  });

  it("treats an oversize package.json as the strict fallback, never as no convention", async () => {
    writeFileSync(join(root, "package.json"), " ".repeat(1_048_577));
    const decision = await resolveGovernedCommitMessagePolicyDecision(
      { editorSettingsControl: controlWith("keiko-conventional", "builtInDefault") },
      root,
    );
    expect(decision).toMatchObject({ mode: "keiko-conventional", source: "fallback" });
  });

  it("logs the real mode of a configured policy", async () => {
    const native = gitCommitMessagePolicyForMode("repository-native");
    const decision = await resolveGovernedCommitMessagePolicyDecision({}, root, native);
    expect(decision).toMatchObject({ mode: "repository-native", source: "setting" });
  });

  it("fails closed to the Conventional check when the settings cannot be read", async () => {
    const control = {
      read: () => Promise.reject(new Error("unavailable")),
    } as unknown as NonNullable<UiHandlerDeps["editorSettingsControl"]>;
    const decision = await resolveGovernedCommitMessagePolicyDecision(
      { editorSettingsControl: control },
      root,
    );
    expect(decision).toMatchObject({ mode: "keiko-conventional", source: "fallback" });
  });
});
