import type { CodingRuntimeGitBranch } from "@oscharko-dev/keiko-contracts";
import { isSafeTaskBranchName } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-git";
import { gitDeliveryTargetIsProtectedBranch } from "@oscharko-dev/keiko-contracts/runtime/git-delivery";
import type {
  GitMutationCommand,
  GitMutationLifecycleResult,
  GitMutationOutcome,
} from "@oscharko-dev/keiko-tools";
import {
  readGitRevision,
  readGitWorktreeSnapshot,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import {
  executeGovernedMutation,
  KEIKO_DEFAULT_PROTECTED_BRANCH_PATTERNS,
  type GitDeliveryExecutionSeams,
  type GitDeliveryMutationDeps,
} from "./execution.js";
import { runtimeGitReadDeps } from "./runtimeGitRead.js";
import type { VerifiedCommitRunContext } from "./verifiedCommitTypes.js";

/**
 * The governed task-branch step of a run (`keiko_git_branch`, #3907, owner decision 2026-10-31):
 * create a new local branch at the run's current commit, switch the run to it, and make it the run's
 * task branch. Both Git effects go through Keiko's own Git kernel (`executeGovernedMutation`: the
 * live snapshot, preflight, policy pack, hardened adapter and evidence ledger of the Git Client's
 * own branch actions); the model never reaches `git checkout -b`, which the native shell still
 * reserves.
 */

/** What the run's workspace says about a task branch being created in it. */
export type RuntimeGitTaskBranchAdmission =
  "admitted" | "not-local-checkout" | "not-on-base" | "executable-filters";

export interface RuntimeGitTaskBranchAdoption {
  readonly runId: string;
  readonly workspaceDigest: string;
  /** The branch Keiko just created and switched to. */
  readonly branch: string;
  /** The base branch the run started from; it is unchanged by the switch. */
  readonly baseBranch: string;
  /** The commit both branches point at. */
  readonly headSha: string;
}

/**
 * The run's workspace, as far as a task branch concerns it. Supplied by the composition that owns
 * the run (productionCodingRuntimeResolver.ts); a service without it refuses every task branch.
 */
export interface RuntimeGitTaskBranchPort {
  /** Whether the run's workspace is a Local checkout standing on its own base branch. */
  readonly admit: () => RuntimeGitTaskBranchAdmission;
  /**
   * Makes the branch the run's own: the workspace instance, the run's record and its Git delivery
   * authority all move together. False, or a throw naming the cause, when any of them could not;
   * nothing stays half-moved either way.
   */
  readonly adopt: (adoption: RuntimeGitTaskBranchAdoption) => boolean;
}

export interface RuntimeGitBranchInput {
  readonly context: VerifiedCommitRunContext;
  readonly mutationDeps: GitDeliveryMutationDeps;
  readonly execution: GitDeliveryExecutionSeams;
  readonly port: RuntimeGitTaskBranchPort | undefined;
  /** The commit the run stands on, from the verified facts read immediately before. */
  readonly headSha: string;
  readonly branchName: string;
}

type Refusal = CodingRuntimeGitBranch["reason"];

/** The name checks alone: a safe ref name that cannot be read as an option and is not protected. */
export function taskBranchNameRefusal(name: string): Refusal | undefined {
  if (!isSafeTaskBranchName(name)) return "invalid-name";
  return gitDeliveryTargetIsProtectedBranch(name, KEIKO_DEFAULT_PROTECTED_BRANCH_PATTERNS)
    ? "protected-name"
    : undefined;
}

function branchResult(
  status: CodingRuntimeGitBranch["status"],
  reason: CodingRuntimeGitBranch["reason"],
  name: string,
): CodingRuntimeGitBranch {
  // The model's own argument is echoed back only when it is a safe, option-free ref name.
  return {
    kind: "branch",
    status,
    reason,
    ...(isSafeTaskBranchName(name) ? { branch: name } : {}),
  };
}

function scopeRefusal(input: RuntimeGitBranchInput): Refusal | undefined {
  // Only a run standing on its own base branch can have a task branch made for it; a run that
  // already works on a task branch keeps it.
  if (input.context.headRef !== input.context.baseRef) return "not-on-base";
  if (input.port === undefined) return "not-local-checkout";
  const admission = input.port.admit();
  return admission === "admitted" ? undefined : admission;
}

function governedDeps(input: RuntimeGitBranchInput): Parameters<typeof readGitWorktreeSnapshot>[0] {
  return {
    ...runtimeGitReadDeps(input.context, input.execution),
    processEnv: input.execution.processEnv,
  };
}

// The live snapshot the kernel judges the branch step against, read in the same hardened lane as
// the Git Client's own snapshots and refused outright once the run's authority has lapsed: this
// read sits immediately before each Git effect.
function readGuardedSnapshot(
  input: RuntimeGitBranchInput,
): ReturnType<typeof readGitWorktreeSnapshot> {
  if (!input.context.stillAuthorized()) throw new Error("git-branch-authority-unavailable");
  return readGitWorktreeSnapshot(governedDeps(input));
}

function guardedSnapshotReader(
  input: RuntimeGitBranchInput,
): NonNullable<GitDeliveryExecutionSeams["snapshotReader"]> {
  return () => readGuardedSnapshot(input);
}

function mutate(
  input: RuntimeGitBranchInput,
  command: GitMutationCommand,
): Promise<GitMutationLifecycleResult> {
  return executeGovernedMutation(
    command,
    { required: false },
    input.context.workspace,
    input.mutationDeps,
    {
      ...input.execution,
      signal: input.context.signal,
      snapshotReader: guardedSnapshotReader(input),
    },
    input.context.correlationId,
  );
}

type Step =
  { readonly done: true } | { readonly done: false; readonly result: CodingRuntimeGitBranch };

/** The closed result of a kernel outcome that is not a success; undefined for a success. */
export function stoppedResult(
  outcome: GitMutationOutcome,
  name: string,
): CodingRuntimeGitBranch | undefined {
  switch (outcome.status) {
    case "succeeded":
      return undefined;
    case "recovery-required":
      return branchResult("recovery-required", "execution-uncertain", name);
    case "failed":
      return branchResult("failed", "execution-failed", name);
    // A deployment policy pack that asks for approval is a policy block for this tool: it has no
    // approval of its own.
    case "approval-required":
      return branchResult("blocked", "policy-block", name);
    case "blocked":
      if (outcome.category === "preflight-block")
        return branchResult("blocked", "preflight-block", name);
      return branchResult(
        "blocked",
        outcome.blockReason === "authority-denied" ? "authority-denied" : "policy-block",
        name,
      );
  }
}

// A kernel outcome, as the next step of the sequence or the closed result that stops it.
function stepOf(lifecycle: GitMutationLifecycleResult, name: string): Step {
  const result = stoppedResult(lifecycle.outcome, name);
  return result === undefined ? { done: true } : { done: false, result };
}

type Existing = "absent" | "at-head" | "elsewhere";

// Whether the branch is already there. A branch at the very commit the run stands on is a retry of
// an earlier, interrupted step and is only switched to; one anywhere else is somebody's work and
// is refused. The current branch counts as existing, so the base branch can never be "created".
async function existingBranch(input: RuntimeGitBranchInput): Promise<Existing> {
  const snapshot = await readGuardedSnapshot(input);
  if (input.branchName === snapshot.currentBranchName) return "elsewhere";
  if (!snapshot.existingLocalBranchNames.includes(input.branchName)) return "absent";
  const tip = await readGitRevision(governedDeps(input), `refs/heads/${input.branchName}`);
  return tip === input.headSha ? "at-head" : "elsewhere";
}

async function createAndSwitch(
  input: RuntimeGitBranchInput,
  existing: "absent" | "at-head",
): Promise<Step> {
  const name = input.branchName;
  if (existing === "absent") {
    const created = stepOf(
      await mutate(input, {
        kind: "branch-create",
        branchName: name,
        baseBranchName: input.context.baseRef,
        startPointRefHash: input.headSha,
      }),
      name,
    );
    if (!created.done) return created;
  }
  return stepOf(await mutate(input, { kind: "branch-switch", branchName: name }), name);
}

// Puts the checkout back on the base branch after the run could not adopt the branch it was just
// switched to, so the workspace and the run's authority agree again. False when the kernel did not
// switch back: the checkout then stays off its base and no longer matches the run's record, which
// leaves the run unauthorized (fail closed) and is reported as such, never as a restored checkout.
async function switchBack(input: RuntimeGitBranchInput): Promise<boolean> {
  const back = await mutate(input, { kind: "branch-switch", branchName: input.context.baseRef });
  return back.outcome.status === "succeeded";
}

/**
 * A run that could not adopt the branch it was just switched to; the caller records the cause on
 * its own log port. The adoption's cause stays the primary failure even when putting the checkout
 * back failed too: `checkoutRestored` says whether the checkout is on its base again, and
 * `switchBackCause` holds what the switch back threw, if it threw.
 */
export class TaskBranchAdoptionFailure extends Error {
  public checkoutRestored = false;
  public switchBackCause: unknown = undefined;
  public constructor(cause: unknown) {
    super("task-branch-adoption-failed", { cause });
    this.name = "TaskBranchAdoptionFailure";
  }
}

/** The closed result the model reads when the run could not adopt its new branch. */
export function adoptionFailedResult(name: string): CodingRuntimeGitBranch {
  return branchResult("failed", "rebind-failed", name);
}

/** The closed result of a branch step whose checkout the kernel could not put back on its base. */
export function checkoutUncertainResult(name: string): CodingRuntimeGitBranch {
  return branchResult("recovery-required", "execution-uncertain", name);
}

// The failure of an adoption that threw or was refused, once the checkout has been put back as far
// as it can be.
async function settledAdoptionFailure(
  input: RuntimeGitBranchInput,
  failure: TaskBranchAdoptionFailure,
): Promise<TaskBranchAdoptionFailure> {
  try {
    failure.checkoutRestored = await switchBack(input);
  } catch (error_) {
    failure.switchBackCause = error_;
    throw failure;
  }
  return failure;
}

async function adoptOrRestore(input: RuntimeGitBranchInput): Promise<CodingRuntimeGitBranch> {
  const name = input.branchName;
  let adopted: boolean;
  try {
    adopted =
      input.port?.adopt({
        runId: input.context.runId,
        workspaceDigest: input.context.workspaceDigest,
        branch: name,
        baseBranch: input.context.baseRef,
        headSha: input.headSha,
      }) === true;
  } catch (cause) {
    throw await settledAdoptionFailure(input, new TaskBranchAdoptionFailure(cause));
  }
  if (adopted) return branchResult("succeeded", "none", name);
  // A refused adoption settles like a thrown one: a switch back that throws leaves the checkout off
  // its base, which the caller reports as an uncertain execution.
  const refused = await settledAdoptionFailure(
    input,
    new TaskBranchAdoptionFailure(new Error("task-branch-adoption-refused")),
  );
  return refused.checkoutRestored ? adoptionFailedResult(name) : checkoutUncertainResult(name);
}

/**
 * Runs the whole governed task-branch step. A refusal is a result; a Git fault throws, and so does
 * an adoption that threw (TaskBranchAdoptionFailure), after the checkout was put back.
 */
export async function runTaskBranch(input: RuntimeGitBranchInput): Promise<CodingRuntimeGitBranch> {
  const name = input.branchName;
  const refusal = taskBranchNameRefusal(name) ?? scopeRefusal(input);
  if (refusal !== undefined) return branchResult("blocked", refusal, name);
  const existing = await existingBranch(input);
  if (existing === "elsewhere") return branchResult("blocked", "branch-exists", name);
  const stepped = await createAndSwitch(input, existing);
  if (!stepped.done) return stepped.result;
  return adoptOrRestore(input);
}
