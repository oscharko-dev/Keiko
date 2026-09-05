import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultChatCapability } from "@oscharko-dev/keiko-model-gateway";
import type { NormalizedResponse, WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import { createGitChangeSnapshotService } from "./gitChangeSnapshotService.js";
import {
  generateGitChangeChatDescription,
  gitChangeChatRefinement,
} from "./gitChangeChatContext.js";
import type { UiHandlerDeps } from "./deps.js";
import type { ChatGitChangeScope } from "./store/index.js";
import { codingWorkbenchRemoteDigest } from "./coding-context/githubIssueResolution.js";
import type { ServerLogEvent } from "./observability/server-log.js";

const NOW = Date.parse("2026-09-05T12:00:00.000Z");
let root: string;

function git(args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  }).trim();
}

function workspace(): WorkspaceInfo {
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

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-chat-description-")));
  git(["init", "--initial-branch=main"]);
  git(["config", "user.email", "test@example.test"]);
  git(["config", "user.name", "Test"]);
  git(["remote", "add", "origin", "https://github.com/owner/repo.git"]);
  writeFileSync(join(root, "code.ts"), "export const value = 1;\n");
  git(["add", "code.ts"]);
  git(["commit", "-m", "initial"]);
  git(["switch", "-c", "feature/chat"]);
  writeFileSync(join(root, "code.ts"), "export const value = 2;\n");
  git(["add", "code.ts"]);
  git(["commit", "-m", "change"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function scopeAndDeps(): Promise<{
  readonly scope: ChatGitChangeScope;
  readonly deps: UiHandlerDeps;
  readonly chat: ReturnType<typeof vi.fn>;
  readonly events: ServerLogEvent[];
}> {
  const snapshots = createGitChangeSnapshotService({ now: () => NOW });
  const captured = await snapshots.capture({
    workspace: workspace(),
    baseRef: "main",
    headRef: "feature/chat",
    expectedHeadSha: git(["rev-parse", "feature/chat"]),
    accessScope: {},
    correlationId: "capture",
  });
  if (captured.reference === undefined || !("snapshotDigest" in captured.snapshot)) {
    throw new Error("snapshot fixture unavailable");
  }
  const snapshot = captured.snapshot;
  const scope: ChatGitChangeScope = {
    kind: "git-change",
    relationshipId: "rel-chat-description",
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
    connectedAtMs: NOW,
  };
  const chat = vi.fn((request: { readonly messages: readonly { readonly content: string }[] }) => {
    const serialized = request.messages.map((message) => message.content).join("\n");
    const evidenceId = /"evidenceId":"([a-f0-9]{64})"/u.exec(serialized)?.[1] ?? "";
    const statement = { text: "Update the exported value.", evidenceIds: [evidenceId] };
    return Promise.resolve({
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
    } satisfies NormalizedResponse);
  });
  const events: ServerLogEvent[] = [];
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
  const deps = {
    gitChangeSnapshotService: snapshots,
    activityLog: { write: (event: ServerLogEvent): void => void events.push(event) },
    prDescriptionGeneration: { gateway: { chat }, config, log: { write: vi.fn() }, now: () => NOW },
  } as unknown as UiHandlerDeps;
  return { scope, deps, chat, events };
}

describe("Git-change Chat shared description core", () => {
  it("uses the exact validated snapshot, bounded history and actual provider usage", async () => {
    const setup = await scopeAndDeps();
    const result = await generateGitChangeChatDescription({
      deps: setup.deps,
      projectPath: root,
      scope: setup.scope,
      correlationId: "chat-description",
      signal: new AbortController().signal,
      history: [
        { role: "system", content: "ignored" },
        { role: "assistant", content: "Earlier draft" },
      ],
      latestIntent: "Emphasize the behavior change",
    });
    expect(result.status).toBe("generated");
    if (result.status !== "generated") throw new Error("description generation failed");
    expect(result.artifact.binding.snapshotDigest).toBe(setup.scope.snapshotDigest);
    expect(result.artifact.markdown).toContain("Update the exported value.");
    expect(result.usage).toEqual({
      modelId: "description-model",
      requestId: "description-request",
      requestCount: 1,
      promptTokens: 11,
      completionTokens: 7,
      latencyMs: 3,
      costClass: "low",
    });
    expect(setup.chat).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(setup.chat.mock.calls)).toContain("Emphasize the behavior change");
    expect(JSON.stringify(setup.chat.mock.calls)).toContain("Earlier draft");
    expect(JSON.stringify(setup.chat.mock.calls)).not.toContain("ignored");
    const event = setup.events.find((entry) => entry.op === "pr-description.chat.generated");
    expect(event?.correlationId).toBe("chat-description");
    expect(event?.extra).toMatchObject({
      relationshipId: setup.scope.relationshipId,
      snapshotDigest: setup.scope.snapshotDigest,
      outcome: "complete",
      requestCount: 1,
    });
    expect(JSON.stringify(setup.events)).not.toContain("Emphasize the behavior change");
    expect(JSON.stringify(setup.events)).not.toContain("Earlier draft");
  });

  it("rejects head drift before model egress", async () => {
    const setup = await scopeAndDeps();
    writeFileSync(join(root, "code.ts"), "export const value = 3;\n");
    git(["add", "code.ts"]);
    git(["commit", "-m", "drift"]);
    const result = await generateGitChangeChatDescription({
      deps: setup.deps,
      projectPath: root,
      scope: setup.scope,
      correlationId: "chat-description-stale",
      signal: new AbortController().signal,
      history: [],
      latestIntent: "Refine",
    });
    expect(result).toEqual({ status: "unavailable", reason: "snapshot-unavailable" });
    expect(setup.chat).not.toHaveBeenCalled();
    expect(
      setup.events.find((entry) => entry.op === "pr-description.chat.unavailable"),
    ).toMatchObject({ errorKind: "snapshot-unavailable" });
  });

  it("bounds untrusted refinement input by UTF-8 bytes", () => {
    const refinement = gitChangeChatRefinement(
      Array.from({ length: 10 }, () => ({ role: "assistant" as const, content: "ü".repeat(1000) })),
      "latest",
    );
    expect(Buffer.byteLength(refinement, "utf8")).toBeLessThanOrEqual(4096);
  });
});
