import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  readVerifiedRepositoryIdentity,
  type VerifiedRepositoryIdentity,
} from "../gitDelivery/verifiedRepositoryIdentity.js";
import { gitDeliveryTerminationHandler } from "../gitDelivery/execution.js";
import { describeError } from "../diagnostics-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { VerifiedCommitRuntimeDependencies } from "./productionVerifiedCommitRuntime.js";
import type { CodingRuntimeLaunchResolver } from "./codingRuntimeOrchestratorTypes.js";
import type { CodingRuntimeTrustedContext } from "./runtimeAuthorityService.js";

type LaunchInput = Parameters<CodingRuntimeLaunchResolver["resolve"]>[0];
const PREPARATION_TTL_MS = 5_000;
interface PreparedContext {
  readonly repositoryIdentity: VerifiedRepositoryIdentity;
  readonly requestDigest: string;
  readonly contextDigest: string;
  readonly expiresAtMs: number;
}
type PreparationDeps = Pick<VerifiedCommitRuntimeDependencies, "resolveWorkspace" | "execution">;
interface PreparationInput {
  readonly deps: PreparationDeps;
  readonly context: (request: LaunchInput) => CodingRuntimeTrustedContext;
  readonly now: () => number;
}
export interface RuntimeGitPreparation {
  readonly prepare: (request: LaunchInput) => Promise<void>;
  readonly consume: (request: LaunchInput) => CodingRuntimeTrustedContext;
}

function contextDigest(context: CodingRuntimeTrustedContext): string {
  // The live clock can advance between bounded I/O and mint; every other authority fact must match.
  return sha256Hex(canonicalise({ ...context, expiresAt: "" }));
}

class GitPreparation implements RuntimeGitPreparation {
  private readonly prepared = new WeakMap<LaunchInput, PreparedContext>();
  public constructor(private readonly input: PreparationInput) {}

  public readonly prepare = async (request: LaunchInput): Promise<void> => {
    this.prepared.delete(request);
    const before = this.input.context(request);
    const expiresAtMs = this.input.now() + PREPARATION_TTL_MS;
    try {
      const repositoryIdentity = await readIdentity(this.input.deps, before, request.runId);
      if (
        this.input.now() >= expiresAtMs ||
        contextDigest(this.input.context(request)) !== contextDigest(before)
      )
        throw new Error("runtime-repository-preparation-drift");
      this.prepared.set(request, {
        repositoryIdentity,
        requestDigest: sha256Hex(canonicalise(request)),
        contextDigest: contextDigest(before),
        expiresAtMs,
      });
      logPreparation(this.input.deps, request.runId, "prepared");
    } catch (error) {
      logPreparation(this.input.deps, request.runId, "failed", error);
      throw error;
    }
  };

  public consume(request: LaunchInput): CodingRuntimeTrustedContext {
    const record = this.prepared.get(request);
    this.prepared.delete(request);
    const current = this.input.context(request);
    if (
      record === undefined ||
      this.input.now() >= record.expiresAtMs ||
      record.requestDigest !== sha256Hex(canonicalise(request)) ||
      record.contextDigest !== contextDigest(current)
    ) {
      logPreparation(this.input.deps, request.runId, "denied");
      throw new Error("runtime-repository-preparation-unavailable");
    }
    logPreparation(this.input.deps, request.runId, "consumed");
    return { ...current, repositoryIdentity: record.repositoryIdentity };
  }
}

export function createRuntimeGitPreparation(input: PreparationInput): RuntimeGitPreparation {
  return new GitPreparation(input);
}

async function readIdentity(
  deps: PreparationDeps,
  context: CodingRuntimeTrustedContext,
  runId: string,
): Promise<VerifiedRepositoryIdentity> {
  const workspace = deps.resolveWorkspace(context.workspaceRoot);
  if (workspace?.root !== context.workspaceRoot) throw new Error("runtime-repository-unavailable");
  const identity = await readVerifiedRepositoryIdentity(
    {
      workspace,
      signal: AbortSignal.timeout(PREPARATION_TTL_MS),
      onTerminated: gitDeliveryTerminationHandler(deps.execution ?? {}, runId),
    },
    sha256Hex(context.workspaceRoot),
  );
  if (context.issueBinding !== undefined && context.issueBinding.remoteDigest !== identity.digest)
    throw new Error("runtime-repository-issue-drift");
  return identity;
}

function logPreparation(
  deps: PreparationDeps,
  runId: string,
  state: "prepared" | "consumed" | "denied" | "failed",
  error?: unknown,
): void {
  (deps.execution?.activityLog ?? processServerLogSink()).write({
    category: "security",
    op: "git.runtime-identity",
    correlationId: runId,
    ...(error === undefined ? {} : ({ level: "warn", errorKind: "internal" } as const)),
    extra: { runId, state, ...(error === undefined ? {} : describeError(error)) },
  });
}
