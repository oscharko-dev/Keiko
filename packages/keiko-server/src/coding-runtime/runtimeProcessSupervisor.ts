import type { Readable } from "node:stream";
import {
  CLOSED_RUNTIME_LAUNCH_PROFILE,
  qualifyLongLivedRuntime,
  type ClosedRuntimeLaunchProfile,
  type LongLivedRuntimeArchitecture,
  type LongLivedRuntimeBackend,
  type LongLivedRuntimePlatform,
  type LongLivedRuntimeQualification,
} from "@oscharko-dev/keiko-sandbox";

export type RuntimeConfinementPlatform = LongLivedRuntimePlatform;
export type RuntimeConfinementArchitecture = LongLivedRuntimeArchitecture;
export type RuntimeConfinementBackend = LongLivedRuntimeBackend;
export type RuntimeQualificationIdentity = LongLivedRuntimeQualification;
export type RuntimeLaunchProfile = ClosedRuntimeLaunchProfile;
export { CLOSED_RUNTIME_LAUNCH_PROFILE };

export interface RuntimeSupervisorLaunchRequest {
  readonly runId: string;
  readonly treeBindingId: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly qualification: RuntimeQualificationIdentity;
  readonly launchProfile: RuntimeLaunchProfile;
}

export interface RuntimeProcessTree {
  readonly treeId: string;
  readonly stdout: Readable;
  readonly stderr: Readable;
  onTreeExit(callback: (code: number | null) => void): void;
}

export type RuntimeTreeSignal = "force" | "graceful";

export interface RuntimeProcessBackend {
  readonly identity: Pick<RuntimeQualificationIdentity, "platform" | "arch" | "backend">;
  spawnOwnedTree(request: RuntimeSupervisorLaunchRequest): RuntimeProcessTree;
  signalTree(tree: RuntimeProcessTree, signal: RuntimeTreeSignal): void;
  waitForCompleteTreeExit(tree: RuntimeProcessTree, timeoutMs: number): Promise<boolean>;
  reconcileTreeExit(tree: RuntimeProcessTree): Promise<boolean>;
}

export type RuntimeSupervisorPreflightResult =
  | { readonly ok: true; readonly launchProfile: RuntimeLaunchProfile }
  | { readonly ok: false; readonly failureCode: "runtime-profile-open" | "runtime-unqualified" };

export type RuntimeSupervisorSpawnResult =
  | { readonly ok: true; readonly tree: RuntimeProcessTree }
  | {
      readonly ok: false;
      readonly failureCode: "runtime-profile-open" | "runtime-unqualified" | "spawn-failed";
    };

export interface RuntimeReapReceipt {
  readonly runId: string;
  readonly treeId: string;
  readonly treeBindingId: string;
}

export type RuntimeTreeExitResult =
  | { readonly status: "reaped"; readonly receipt: RuntimeReapReceipt }
  | { readonly status: "recovery-required" };

const VALID_REAP_RECEIPTS = new WeakSet<RuntimeReapReceipt>();

export function verifyRuntimeReapReceipt(
  receipt: RuntimeReapReceipt,
  runId: string,
  treeBindingId: string,
): boolean {
  return (
    VALID_REAP_RECEIPTS.has(receipt) &&
    receipt.runId === runId &&
    receipt.treeBindingId === treeBindingId
  );
}

export interface RuntimeProcessSupervisor {
  preflight(request: RuntimeSupervisorLaunchRequest): RuntimeSupervisorPreflightResult;
  spawnOwnedTree(request: RuntimeSupervisorLaunchRequest): RuntimeSupervisorSpawnResult;
  terminate(tree: RuntimeProcessTree, signal: RuntimeTreeSignal): void;
  waitForCompleteTreeExit(
    tree: RuntimeProcessTree,
    timeoutMs: number,
  ): Promise<RuntimeTreeExitResult>;
  reconcile(tree: RuntimeProcessTree): Promise<RuntimeTreeExitResult>;
}

export interface RuntimeProcessSupervisorDeps {
  readonly backend: RuntimeProcessBackend;
  readonly qualifications?: readonly RuntimeQualificationIdentity[] | undefined;
}

export function createRuntimeProcessSupervisor(
  deps: RuntimeProcessSupervisorDeps,
): RuntimeProcessSupervisor {
  return new RuntimeProcessSupervisorImpl(deps.backend, deps.qualifications ?? []);
}

class RuntimeProcessSupervisorImpl implements RuntimeProcessSupervisor {
  private readonly ownedTrees = new Set<RuntimeProcessTree>();
  private readonly ownedRunIds = new WeakMap<RuntimeProcessTree, string>();
  private readonly ownedTreeBindingIds = new WeakMap<RuntimeProcessTree, string>();
  private readonly reapedReceipts = new WeakMap<RuntimeProcessTree, RuntimeReapReceipt>();

  public constructor(
    private readonly backend: RuntimeProcessBackend,
    private readonly qualifications: readonly RuntimeQualificationIdentity[],
  ) {}

  public preflight(request: RuntimeSupervisorLaunchRequest): RuntimeSupervisorPreflightResult {
    if (!profileIsClosed(request.launchProfile)) {
      return { ok: false, failureCode: "runtime-profile-open" };
    }
    return backendMatches(this.backend, request.qualification) &&
      qualifyLongLivedRuntime(request.qualification, this.qualifications).ok
      ? { ok: true, launchProfile: CLOSED_RUNTIME_LAUNCH_PROFILE }
      : { ok: false, failureCode: "runtime-unqualified" };
  }

  public spawnOwnedTree(request: RuntimeSupervisorLaunchRequest): RuntimeSupervisorSpawnResult {
    const preflight = this.preflight(request);
    if (!preflight.ok) return preflight;
    try {
      const tree = this.backend.spawnOwnedTree(request);
      this.ownedTrees.add(tree);
      this.ownedRunIds.set(tree, request.runId);
      this.ownedTreeBindingIds.set(tree, request.treeBindingId);
      return { ok: true, tree };
    } catch {
      return { ok: false, failureCode: "spawn-failed" };
    }
  }

  public terminate(tree: RuntimeProcessTree, signal: RuntimeTreeSignal): void {
    this.assertOwned(tree);
    this.backend.signalTree(tree, signal);
  }

  public async waitForCompleteTreeExit(
    tree: RuntimeProcessTree,
    timeoutMs: number,
  ): Promise<RuntimeTreeExitResult> {
    this.assertOwned(tree);
    return this.recordExit(tree, await this.backend.waitForCompleteTreeExit(tree, timeoutMs));
  }

  public async reconcile(tree: RuntimeProcessTree): Promise<RuntimeTreeExitResult> {
    const receipt = this.reapedReceipts.get(tree);
    if (receipt !== undefined) return { status: "reaped", receipt };
    this.assertOwned(tree);
    return this.recordExit(tree, await this.backend.reconcileTreeExit(tree));
  }

  private assertOwned(tree: RuntimeProcessTree): void {
    if (!this.ownedTrees.has(tree)) throw new Error("runtime-tree-not-owned");
  }

  private recordExit(tree: RuntimeProcessTree, reaped: boolean): RuntimeTreeExitResult {
    if (reaped) {
      this.ownedTrees.delete(tree);
      const runId = this.ownedRunIds.get(tree);
      const treeBindingId = this.ownedTreeBindingIds.get(tree);
      if (runId === undefined || treeBindingId === undefined) {
        throw new Error("runtime-tree-binding-missing");
      }
      const receipt = Object.freeze({ runId, treeId: tree.treeId, treeBindingId });
      VALID_REAP_RECEIPTS.add(receipt);
      this.reapedReceipts.set(tree, receipt);
      return { status: "reaped", receipt };
    }
    return { status: "recovery-required" };
  }
}

function profileIsClosed(profile: unknown): boolean {
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return false;
  const record = profile as Record<string, unknown>;
  return (
    Object.keys(record).length === CLOSED_PROFILE_KEYS.length &&
    CLOSED_PROFILE_KEYS.every((key) => record[key] === false)
  );
}

const CLOSED_PROFILE_KEYS = [
  "upstreamEditAuthority",
  "upstreamShellAuthority",
  "upstreamGitAuthority",
  "upstreamDeliveryAuthority",
  "upstreamConnectorAuthority",
  "upstreamBrowserAuthority",
  "unrestrictedNetworkAuthority",
] as const;

function backendMatches(
  backend: RuntimeProcessBackend,
  qualification: RuntimeQualificationIdentity,
): boolean {
  return (
    backend.identity.platform === qualification.platform &&
    backend.identity.arch === qualification.arch &&
    backend.identity.backend === qualification.backend
  );
}
