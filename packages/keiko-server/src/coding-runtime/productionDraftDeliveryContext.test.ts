import { describe, expect, it } from "vitest";
import type { CodingWorkbenchIssueBinding } from "@oscharko-dev/keiko-contracts";
import { resolveDraftDeliveryContext } from "./productionDraftDeliveryRuntime.js";
import type {
  VerifiedCommitRuntimeBinding,
  VerifiedCommitRuntimeDependencies,
} from "./productionVerifiedCommitRuntime.js";
import type { CodingRuntimeTrustedContext } from "./runtimeAuthorityService.js";

// ADR-0085 D1b: a run with no accepted issue is a normal run. Its delivery context used to resolve
// to nothing, so every push it proposed was refused without a cause.
const DIGEST = "a".repeat(64);
const ROOT = "/workspace/task";
const workspace = {
  root: ROOT,
  selectedRoot: ROOT,
  name: "task",
  version: undefined,
  testFramework: "vitest",
  sourceDirs: [],
  testDirs: [],
  languages: [],
  ignoreLines: [],
} as const;
const issueBinding = {
  schemaVersion: "1",
  repositoryId: "repository-1",
  remoteDigest: DIGEST,
  issueNumber: 7,
  issueIdDigest: DIGEST,
  defaultBaseRef: "main",
  contentRevisionDigest: DIGEST,
  bindingDigest: DIGEST,
} as unknown as CodingWorkbenchIssueBinding;

function dependencies(): VerifiedCommitRuntimeDependencies {
  return {
    snapshots: { get: () => ({ authorityDigest: DIGEST, workspaceDigest: DIGEST }) },
    resolveWorkspace: (root: string) => (root === ROOT ? workspace : undefined),
    buffersClean: () => true,
  } as unknown as VerifiedCommitRuntimeDependencies;
}
type Overrides = {
  -readonly [K in keyof CodingRuntimeTrustedContext]?: CodingRuntimeTrustedContext[K] | undefined;
};
function binding(context: Overrides): VerifiedCommitRuntimeBinding {
  return {
    runId: "run-0001-abcdef",
    envelopeDigest: DIGEST,
    stillAuthorized: () => true,
    signal: new AbortController().signal,
    context: {
      taskId: "task-1",
      workspaceId: "workspace-1",
      workspaceRoot: ROOT,
      branch: { baseRef: "main", headRef: "claude/task-1" },
      repositoryIdentity: { kind: "foreign-origin", digest: DIGEST },
      ...context,
    },
  } as unknown as VerifiedCommitRuntimeBinding;
}

describe("draft delivery context of a run", () => {
  it("resolves for a run with no accepted issue and carries how its repository was admitted", () => {
    const context = resolveDraftDeliveryContext(dependencies(), binding({}));
    expect(context).toMatchObject({
      runId: "run-0001-abcdef",
      taskId: "task-1",
      workspaceId: "workspace-1",
      repositoryDigest: DIGEST,
      repositoryKind: "foreign-origin",
      baseRef: "main",
      headRef: "claude/task-1",
    });
    expect(context).not.toHaveProperty("issueBinding");
    expect(context).not.toHaveProperty("issueBindingDigest");
  });

  it("keeps the accepted issue of an issue-bound run", () => {
    const context = resolveDraftDeliveryContext(dependencies(), binding({ issueBinding }));
    expect(context?.issueBinding).toBe(issueBinding);
    expect(context?.issueBindingDigest).toBe(DIGEST);
  });

  it("marks a repository without origin as local so a push can name remote-required", () => {
    const context = resolveDraftDeliveryContext(
      dependencies(),
      binding({ repositoryIdentity: { kind: "local", digest: DIGEST } }),
    );
    expect(context?.repositoryKind).toBe("local");
  });

  it("resolves nothing without an admitted repository identity or a live workspace", () => {
    expect(
      resolveDraftDeliveryContext(dependencies(), binding({ repositoryIdentity: undefined })),
    ).toBeUndefined();
    expect(
      resolveDraftDeliveryContext(dependencies(), binding({ workspaceRoot: "/elsewhere" })),
    ).toBeUndefined();
  });
});
