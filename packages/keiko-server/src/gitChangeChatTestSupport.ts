import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDefaultChatCapability } from "@oscharko-dev/keiko-model-gateway";
import type {
  GitChangeSnapshot,
  NormalizedResponse,
  WorkspaceInfo,
} from "@oscharko-dev/keiko-contracts";
import { createGitChangeSnapshotService } from "./gitChangeSnapshotService.js";
import type { UiHandlerDeps } from "./deps.js";
import type { ChatGitChangeScope } from "./store/index.js";
import { codingWorkbenchRemoteDigest } from "./coding-context/githubIssueResolution.js";

const FIXTURE_NOW = Date.parse("2026-09-05T12:00:00.000Z");
const GIT_EXECUTABLE =
  process.platform === "win32" ? String.raw`C:\Program Files\Git\cmd\git.exe` : "/usr/bin/git";

function git(root: string, args: readonly string[]): string {
  return execFileSync(GIT_EXECUTABLE, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  }).trim();
}

function initializeRepository(root: string): void {
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.test"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);
  writeFileSync(join(root, "code.ts"), "export const value = 1;\n");
  git(root, ["add", "code.ts"]);
  git(root, ["commit", "-m", "initial"]);
  git(root, ["switch", "-c", "feature/chat"]);
  writeFileSync(join(root, "code.ts"), "export const value = 2;\n");
  git(root, ["add", "code.ts"]);
  git(root, ["commit", "-m", "change"]);
}

function workspace(root: string): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: "repo",
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

function descriptionResponse(request: {
  readonly messages: readonly { readonly content: string }[];
}): NormalizedResponse {
  const text = request.messages.map((message) => message.content).join("\n");
  const evidenceId = /"evidenceId":"([a-f0-9]{64})"/u.exec(text)?.[1] ?? "";
  const statement = { text: "Update the exported value.", evidenceIds: [evidenceId] };
  return {
    modelId: "description-model",
    content: JSON.stringify({
      summary: [statement],
      keyChanges: [statement],
      risks: [],
      reviewerFocus: [],
    }),
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "description-request",
      promptTokens: 11,
      completionTokens: 7,
      latencyMs: 3,
      costClass: "low",
    },
  };
}

function generation(): NonNullable<UiHandlerDeps["prDescriptionGeneration"]> {
  const config = {
    providers: [
      {
        modelId: "description-model",
        baseUrl: "https://example.test",
        apiKey: "fixture",
        timeoutMs: 1000,
        maxRetries: 0,
        retryBaseDelayMs: 1,
      },
    ],
    circuitBreaker: { failureThreshold: 3, cooldownMs: 1000, halfOpenProbes: 1 },
    capabilities: [
      {
        ...createDefaultChatCapability("description-model"),
        contextWindow: 32_768,
        maxOutputTokens: 2048,
      },
    ],
  };
  return {
    gateway: {
      chat: (request): Promise<NormalizedResponse> => Promise.resolve(descriptionResponse(request)),
    },
    config,
    log: { write: () => undefined },
    now: () => FIXTURE_NOW,
  };
}

function scopeFor(snapshot: GitChangeSnapshot): ChatGitChangeScope {
  return {
    kind: "git-change",
    relationshipId: "rel-description",
    remoteDigest: codingWorkbenchRemoteDigest("owner/repo"),
    comparisonLabel: "main...feature/chat",
    baseRef: snapshot.baseRef,
    headRef: snapshot.headRef,
    baseSha: snapshot.baseSha,
    headSha: snapshot.headSha,
    mergeBaseSha: snapshot.mergeBaseSha,
    snapshotDigest: snapshot.snapshotDigest,
    fileCount: snapshot.completeness.files,
    totalFiles: snapshot.completeness.totalFiles,
    omittedFiles: snapshot.completeness.omittedFiles,
    truncatedFiles: snapshot.completeness.truncatedFiles,
    descriptionStatus: "current",
    connectedAtMs: FIXTURE_NOW,
  };
}

export async function initializeGitChangeDescriptionFixture(root: string): Promise<{
  readonly scope: ChatGitChangeScope;
  readonly deps: Pick<
    UiHandlerDeps,
    "gitChangeSnapshotService" | "prDescriptionGeneration" | "activityLog"
  >;
}> {
  initializeRepository(root);
  const snapshots = createGitChangeSnapshotService({ now: () => FIXTURE_NOW });
  const captured = await snapshots.capture({
    workspace: workspace(root),
    baseRef: "main",
    headRef: "feature/chat",
    expectedHeadSha: git(root, ["rev-parse", "feature/chat"]),
    accessScope: {},
    correlationId: "fixture-capture",
  });
  if (captured.reference === undefined || !("snapshotDigest" in captured.snapshot)) {
    throw new Error("snapshot fixture unavailable");
  }
  return {
    scope: scopeFor(captured.snapshot),
    deps: {
      gitChangeSnapshotService: snapshots,
      activityLog: { write: () => undefined },
      prDescriptionGeneration: generation(),
    },
  };
}
