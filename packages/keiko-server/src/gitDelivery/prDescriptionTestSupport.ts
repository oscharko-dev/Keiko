import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultChatCapability, PrDescription } from "@oscharko-dev/keiko-model-gateway";
import type { NormalizedResponse, PrDescriptionArtifact } from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import type { PrDescriptionApplicationStatus } from "@oscharko-dev/keiko-contracts/runtime/pr-description-application";
import type {
  GitPrBody,
  GitPrBodyUpdateRequest,
  GitPrExecResult,
  GitPrInspectionResult,
  GitPullRequestBodyAdapter,
  GitWorktreeSnapshot,
} from "@oscharko-dev/keiko-tools";
import { createGitChangeSnapshotService } from "../gitChangeSnapshotService.js";
import type { ServerLogEvent } from "../observability/server-log.js";
import { createInMemoryGitDeliveryApprovalStore } from "./approvalStore.js";
import { createPrDescriptionApplicationService } from "./prDescriptionService.js";
import type { PrDescriptionContext, PrDescriptionServiceOptions } from "./prDescriptionTypes.js";

const GIT_EXECUTABLE =
  process.platform === "win32" ? String.raw`C:\Program Files\Git\cmd\git.exe` : "/usr/bin/git";

export class DescriptionFixture {
  public readonly root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-description-")));
  public readonly events: ServerLogEvent[] = [];
  public readonly evidence = new Map<string, string>();
  public readonly writes: GitPrBodyUpdateRequest[] = [];
  public readonly snapshots = createGitChangeSnapshotService({
    logSink: { write: (event) => this.events.push(event) },
    now: () => this.now,
  });
  public now = Date.parse("2026-09-05T00:00:00.000Z");
  public live = true;
  public persistence = true;
  public lostResponse = false;
  public keepOld = false;
  public afterWrite: (() => void) | undefined;
  public beforeRead: (() => void) | undefined;
  public afterCapture: (() => void) | undefined;
  public status: PrDescriptionApplicationStatus | undefined;
  public readonly context: PrDescriptionContext;
  public remote: GitPrBody;
  public readonly options: PrDescriptionServiceOptions;
  public readonly service: ReturnType<typeof createPrDescriptionApplicationService>;
  public constructor() {
    this.initialize();
    this.git(["remote", "add", "origin", "https://github.com/owner/repo.git"]);
    writeFileSync(join(this.root, "code.ts"), "export const value = 1;\n");
    this.git(["add", "code.ts"]);
    this.git(["commit", "-m", "initial"]);
    const baseSha = this.git(["rev-parse", "HEAD"]);
    this.git(["branch", "main", baseSha]);
    writeFileSync(join(this.root, "code.ts"), "export const value = 2;\n");
    this.git(["add", "code.ts"]);
    this.git(["commit", "-m", "change"]);
    this.remote = {
      identity: {
        number: 123,
        externalId: "PR_Test",
        url: "https://github.com/owner/repo/pull/123",
        repository: "owner/repo",
        headRepository: "owner/repo",
        headRef: "feature",
        headSha: this.git(["rev-parse", "HEAD"]),
        baseRef: "main",
        baseSha,
        state: "open",
        isDraft: true,
      },
      body: "# Human template\r\n\r\nCloses #42\r\n",
      updatedAt: new Date(this.now - 1000).toISOString(),
    };
    this.context = {
      workspace: {
        root: this.root,
        selectedRoot: this.root,
        name: "test",
        version: undefined,
        testFramework: "vitest",
        sourceDirs: [],
        testDirs: [],
        languages: [],
        ignoreLines: [],
      },
      repository: "owner/repo",
      prNumber: 123,
      accessScope: {},
      authorityDigest: sha256Hex("authority"),
      correlationId: "description-test",
      stillAuthorized: (): boolean => this.live,
    };
    this.options = this.makeOptions();
    this.service = createPrDescriptionApplicationService(this.options);
  }
  private initialize(): void {
    this.git(["init", "--initial-branch=feature"]);
    this.git(["config", "user.email", "test@example.test"]);
    this.git(["config", "user.name", "Test"]);
  }
  public async generateArtifact(
    refinement = "Chat-selected intent",
    refs?: { readonly baseRef: string; readonly headRef: string },
  ): Promise<PrDescriptionArtifact> {
    const captureInput = {
      workspace: this.context.workspace,
      baseRef: refs?.baseRef ?? this.remote.identity.baseSha,
      headRef: refs?.headRef ?? this.remote.identity.headSha,
      expectedHeadSha: this.remote.identity.headSha,
      accessScope: this.context.accessScope,
      correlationId: this.context.correlationId,
    };
    const captured = await this.snapshots.capture(captureInput);
    if (captured.reference === undefined) throw new Error("description snapshot unavailable");
    const result = await PrDescription.generatePrDescription(
      {
        snapshotReference: captured.reference,
        language: "en",
        refinement,
        authority: {
          authorityDigest: this.context.authorityDigest,
          correlationId: this.context.correlationId,
        },
      },
      {
        ...this.generation(),
        revalidateAuthority: (_authority, signal) =>
          !signal.aborted && this.context.stillAuthorized(),
        resolveSnapshot: (reference) => {
          const content = this.snapshots.read(
            reference,
            this.context.accessScope,
            this.context.correlationId,
          );
          return Promise.resolve(
            content === undefined
              ? undefined
              : {
                  snapshot: content.snapshot,
                  evidence: content.files.map((file) => ({
                    evidenceId: file.evidenceId,
                    text: JSON.stringify(file),
                  })),
                },
          );
        },
      },
    );
    if (result.status !== "generated") throw new Error("description generation unavailable");
    return result.artifact;
  }
  private git(args: string[]): string {
    return execFileSync(GIT_EXECUTABLE, args, {
      cwd: this.root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    }).trim();
  }
  private makeOptions(): PrDescriptionServiceOptions {
    return {
      context: () => this.context,
      snapshots: {
        ...this.snapshots,
        capture: async (input): ReturnType<PrDescriptionServiceOptions["snapshots"]["capture"]> => {
          const result = await this.snapshots.capture(input);
          this.afterCapture?.();
          return result;
        },
      },
      generation: this.generation(),
      adapter: () => this.adapter(),
      mutationDeps: {
        redactor: (value) => value,
        evidenceStore: {
          put: (id, value): string => {
            this.evidence.set(id, value);
            return id;
          },
          list: () => [...this.evidence.keys()],
          get: (id) => this.evidence.get(id),
          delete: (id): void => {
            this.evidence.delete(id);
          },
        },
      },
      execution: {
        now: () => this.now,
        approvalStore: createInMemoryGitDeliveryApprovalStore(),
        activityLog: { write: (event) => this.events.push(event) },
        snapshotReader: (): Promise<GitWorktreeSnapshot> =>
          Promise.resolve({
            currentBranchName: "feature",
            headDetached: false,
            stagedFileCount: 0,
            unstagedFileCount: 0,
            untrackedFileCount: 0,
            hasUpstream: false,
            aheadCount: 0,
            behindCount: 0,
            existingLocalBranchNames: ["feature"],
            remoteAliases: ["origin"],
          }),
      },
      recordStatus: (_context, status): boolean => this.persist(status),
      readStatus: () => this.status,
    };
  }
  private persist(status: PrDescriptionApplicationStatus): boolean {
    if (!this.persistence) return false;
    this.status = structuredClone(status);
    return true;
  }
  private adapter(): GitPullRequestBodyAdapter {
    return {
      readPullRequestBody: (): Promise<GitPrInspectionResult<GitPrBody>> => {
        this.beforeRead?.();
        return Promise.resolve({ ok: true, value: structuredClone(this.remote) });
      },
      updatePullRequestBody: (request): Promise<GitPrExecResult> => {
        this.writes.push(structuredClone(request));
        if (!this.keepOld)
          this.remote = {
            ...this.remote,
            body: request.body,
            updatedAt: new Date(this.now).toISOString(),
          };
        this.afterWrite?.();
        return Promise.resolve({
          schemaVersion: "1",
          outcome: this.lostResponse ? "failed" : "succeeded",
          durationMs: 1,
        });
      },
    };
  }
  private generation(): PrDescriptionServiceOptions["generation"] {
    return {
      now: () => this.now,
      log: { write: () => undefined },
      config: {
        providers: [
          {
            modelId: "test",
            baseUrl: "https://example.test",
            apiKey: "fixture",
            timeoutMs: 1000,
            maxRetries: 0,
            retryBaseDelayMs: 1,
          },
        ],
        circuitBreaker: { failureThreshold: 3, cooldownMs: 1000, halfOpenProbes: 1 },
        capabilities: [
          { ...createDefaultChatCapability("test"), contextWindow: 32_768, maxOutputTokens: 2048 },
        ],
      },
      gateway: {
        chat: (request): Promise<NormalizedResponse> => {
          const serialized = request.messages
            .map((message) => (typeof message.content === "string" ? message.content : ""))
            .join("\n");
          const evidenceId = /"evidenceId":"([a-f0-9]{64})/u.exec(serialized)?.[1] ?? "";
          const statement = { text: "Change the exported value.", evidenceIds: [evidenceId] };
          return Promise.resolve({
            modelId: "test",
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
              requestId: "test",
              promptTokens: 10,
              completionTokens: 20,
              latencyMs: 1,
              costClass: "medium",
            },
          });
        },
      },
    };
  }
  public close(): void {
    this.snapshots.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}
