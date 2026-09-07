import { CI_OPERATIONS, type CiFixtureOperation } from "../support/coding-issue-ci.js";
import { invokeCiFixture } from "./coding-issue-ci-driver.mjs";
import type { ScriptedToolPhase } from "../../../packages/keiko-server/src/coding-runtime/opencodeFunctionalHarness/_governedTools.js";
// Composed functional fixture only: real authority, Git, verification and approvals; scripted model.
import {
  DeliveryFixtureDriver,
  deferredDeliveryDependencies,
  selectDeliveryProviderRef,
} from "./coding-issue-delivery-fixture.mjs";
import {
  DELIVERY_OPERATIONS,
  type DeliveryFixtureOperation,
} from "../support/coding-issue-delivery.js";
import type { DraftDeliveryDependencies } from "../../../packages/keiko-server/src/gitDelivery/draftDeliveryTypes.js";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import type { UiHandlerDeps } from "../../../packages/keiko-server/src/deps.js";
import type { CodingRuntimeSnapshotStore } from "../../../packages/keiko-server/src/coding-runtime/codingRuntimeSnapshotStore.js";
import type { ProductionRuntimeBackendInput } from "../../../packages/keiko-server/src/coding-runtime/productionCodingRuntimeResolver.js";
import type { VerifiedCommitRuntimeDependencies } from "../../../packages/keiko-server/src/coding-runtime/productionVerifiedCommitRuntime.js";
import { createProductionVerifiedCommitDependencies } from "../../../packages/keiko-server/src/coding-runtime/productionVerifiedCommitDependencies.js";
import type { CodingToolResult } from "../../../packages/keiko-server/src/coding-runtime/codingToolIpc.js";
import {
  COMMIT_MESSAGE,
  COMMIT_OPERATIONS,
  commitControlPath,
  commitObservationPath,
  type CommitFixtureOperation,
} from "../support/coding-issue-commit.js";

interface CommitFixtureInput {
  readonly deps: () => UiHandlerDeps;
  readonly snapshots: CodingRuntimeSnapshotStore;
  readonly stateDir: string;
  readonly target: string;
  readonly delivery?: boolean;
  readonly ciReader?: DraftDeliveryDependencies["ciReader"];
}

/** The resolver is constructed before the BFF; all real ports resolve from the completed assembly. */
export function createDeferredVerifiedCommitDependencies(
  input: Pick<CommitFixtureInput, "deps" | "snapshots">,
): VerifiedCommitRuntimeDependencies {
  let cached: VerifiedCommitRuntimeDependencies | undefined;
  const actual = (): VerifiedCommitRuntimeDependencies => {
    cached ??= createProductionVerifiedCommitDependencies(input.deps(), input.snapshots);
    if (cached === undefined) throw new Error("commit-fixture-dependencies-unavailable");
    return cached;
  };
  return {
    snapshots: input.snapshots,
    get mutationDeps(): VerifiedCommitRuntimeDependencies["mutationDeps"] {
      return actual().mutationDeps;
    },
    get execution(): NonNullable<VerifiedCommitRuntimeDependencies["execution"]> {
      const value = actual().execution;
      if (value === undefined) throw new Error("commit-fixture-execution-unavailable");
      return value;
    },
    messageAllowed: (message, workspace) => actual().messageAllowed(message, workspace),
    resolveWorkspace: (root) => actual().resolveWorkspace(root),
    buffersClean: (root, runId) => actual().buffersClean(root, runId),
  };
}

interface Control {
  readonly id: number;
  readonly operation: CommitFixtureOperation | DeliveryFixtureOperation | CiFixtureOperation;
  readonly proposalId?: string;
}
const CONTROL_KEYS = new Set(["id", "operation", "proposalId"]);
function isValidControlRecord(record: Readonly<Record<string, unknown>>): record is Readonly<
  Record<string, unknown>
> & {
  readonly id: number;
  readonly proposalId?: string;
} {
  const keys = Object.keys(record);
  const proposalId = record.proposalId;
  return (
    keys.length >= 2 &&
    keys.length <= 3 &&
    keys.every((key) => CONTROL_KEYS.has(key)) &&
    typeof record.id === "number" &&
    Number.isSafeInteger(record.id) &&
    record.id > 0 &&
    (proposalId === undefined ||
      (typeof proposalId === "string" && /^(?:commit|delivery)-[0-9]+$/u.test(proposalId)))
  );
}
function readControl(stateDir: string, delivery: boolean, ci: boolean): Control | undefined {
  const value: unknown = JSON.parse(readFileSync(commitControlPath(stateDir), "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const allowed = allowedControls(delivery, ci);
  const operation = allowed.find((candidate) => candidate === record.operation);
  if (operation === undefined || !isValidControlRecord(record)) return undefined;
  return {
    id: record.id,
    operation,
    ...(typeof record.proposalId === "string" ? { proposalId: record.proposalId } : {}),
  };
}

function allowedControls(delivery: boolean, ci: boolean): readonly Control["operation"][] {
  return [
    ...COMMIT_OPERATIONS,
    ...(delivery ? DELIVERY_OPERATIONS : []),
    ...(ci ? CI_OPERATIONS : []),
  ];
}

export interface CodingIssueCommitFixture {
  readonly verifiedCommit: VerifiedCommitRuntimeDependencies;
  readonly draftDelivery?: DraftDeliveryDependencies;
  readonly observeBackendRun: (run: ProductionRuntimeBackendInput) => void;
  readonly beforeResponse: (response: NormalizedResponse) => Promise<void>;
  readonly observeToolPhase: (event: ScriptedToolPhase) => void;
}
type FixturePhase =
  | CommitFixtureOperation
  | DeliveryFixtureOperation
  | CiFixtureOperation
  | "run-created"
  | "stage-proposed"
  | "candidate-staged"
  | "control-pending"
  | "control-failed"
  | "verified-turn-ready";

class CommitFixture implements CodingIssueCommitFixture {
  readonly verifiedCommit: VerifiedCommitRuntimeDependencies;
  readonly draftDelivery?: DraftDeliveryDependencies;
  private readonly deliveryDriver = new DeliveryFixtureDriver();
  private run: ProductionRuntimeBackendInput | undefined;
  private proposalId: string | undefined;
  private lastControl = 0;
  private sequence = 0;
  private readonly toolPhases: ScriptedToolPhase[] = [];
  private readonly modelResponsePhases: string[] = [];
  private latestPhase: FixturePhase = "run-created";
  private latestResult: CodingToolResult | undefined;
  private staging: Promise<void> | undefined;
  private readonly completedControls = new Set<number>();
  private readonly controlResults = new Map<number, CodingToolResult>();
  private readonly failedControls = new Set<number>();
  constructor(private readonly input: CommitFixtureInput) {
    this.verifiedCommit = createDeferredVerifiedCommitDependencies(input);
    if (input.delivery === true)
      this.draftDelivery = deferredDeliveryDependencies(
        input.deps,
        input.snapshots,
        input.ciReader,
      );
    writeFileSync(commitControlPath(input.stateDir), "{}");
  }
  private write(phase: FixturePhase, result?: CodingToolResult): void {
    this.latestPhase = phase;
    this.latestResult = result;
    const path = commitObservationPath(this.input.stateDir);
    const temporary = `${path}.${randomUUID()}.next`;
    try {
      writeFileSync(
        temporary,
        JSON.stringify({
          sequence: ++this.sequence,
          runId: this.run?.request.runId,
          phase,
          lastControl: this.lastControl,
          ...(result === undefined ? {} : { result }),
          completedControls: [...this.completedControls],
          controlResults: Object.fromEntries(this.controlResults),
          failedControls: [...this.failedControls],
          rawContentRecorded: false,
          toolPhases: this.toolPhases,
          modelResponsePhases: this.modelResponsePhases,
        }),
        { flag: "wx" },
      );
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  public observeToolPhase(event: ScriptedToolPhase): void {
    if (event.runId !== this.run?.request.runId) return;
    this.toolPhases.push(event);
    if (this.toolPhases.length > 128) this.toolPhases.shift();
    this.write(this.latestPhase, this.latestResult);
    if (event.tool === "keiko_changeset_edit" && event.phase === "completed") {
      this.staging ??= this.stageCandidate();
      void this.staging.catch(() => undefined);
    }
  }
  private async invoke(control: Control): Promise<boolean> {
    const { operation } = control;
    if (operation === "finish") {
      this.completedControls.add(control.id);
      this.write("finish");
      return true;
    }
    const run = this.run;
    if (run === undefined) throw new Error("commit-fixture-run-unavailable");
    const ci = CI_OPERATIONS.find((entry) => entry === operation);
    if (ci !== undefined) {
      this.completeControl(
        control,
        await invokeCiFixture(run, ci, control.id, () => this.stageCandidate()),
      );
      return false;
    }
    if (operation !== "propose" && operation !== "execute") {
      this.completeControl(
        control,
        await this.deliveryDriver.invoke(
          run,
          operation as DeliveryFixtureOperation,
          control.id,
          control.proposalId,
        ),
      );
      return false;
    }
    const identity = `commit-fixture-${String(control.id)}`;
    const result = await run.toolFacade.execute({
      capability: run.minted.toolFacadeCapability,
      body: JSON.stringify({
        action: "delivery",
        intent: "commit",
        actionId: identity,
        idempotencyKey: identity,
        ...(operation === "propose"
          ? { phase: "propose", message: COMMIT_MESSAGE }
          : { phase: "execute", proposalId: control.proposalId ?? this.proposalId }),
      }),
    });
    if ("verifiedCommit" in result) this.proposalId = result.verifiedCommit.proposalId;
    this.completeControl(control, result);
    return false;
  }
  private completeControl(control: Control, result: CodingToolResult): void {
    this.completedControls.add(control.id);
    this.controlResults.set(control.id, result);
    this.write(control.operation, result);
  }
  private startControl(control: Control): Promise<boolean> | boolean {
    if (!control.operation.endsWith("propose")) return this.invoke(control);
    this.write("control-pending");
    void this.invoke(control).catch(() => {
      this.failedControls.add(control.id);
      this.write("control-failed");
      process.stderr.write("commit-fixture-control-failed\n");
    });
    return false;
  }
  private async waitForControls(): Promise<void> {
    const deadline = Date.now() + 180_000;
    this.write("verified-turn-ready");
    while (Date.now() < deadline) {
      const control = readControl(
        this.input.stateDir,
        this.input.delivery === true,
        this.input.ciReader !== undefined,
      );
      if (control !== undefined && control.id > this.lastControl) {
        this.lastControl = control.id;
        if (await this.startControl(control)) return;
      }
      await setTimeout(25);
    }
    throw new Error("commit-fixture-control-deadline");
  }
  public observeBackendRun(run: ProductionRuntimeBackendInput): void {
    this.run = run;
    if (this.input.delivery === true) selectDeliveryProviderRef(this.input.stateDir, run);
    this.proposalId = undefined;
    this.staging = undefined;
    this.completedControls.clear();
    this.controlResults.clear();
    this.failedControls.clear();
    this.write("run-created");
  }
  public async beforeResponse(response: NormalizedResponse): Promise<void> {
    if (this.run === undefined) throw new Error("commit-fixture-run-unavailable");
    const requestedTool = response.toolCalls[0]?.name ?? "none";
    this.modelResponsePhases.push(`${requestedTool}:entered`);
    this.write(this.latestPhase, this.latestResult);
    if (response.toolCalls.some((call) => call.name === "keiko_verification")) {
      if (this.staging === undefined) throw new Error("commit-fixture-stage-unavailable");
      await this.staging;
    }
    this.modelResponsePhases.push(`${requestedTool}:returned`);
    this.write(this.latestPhase, this.latestResult);
    if (response.toolCalls.length === 0) await this.waitForControls();
  }

  private async stageCandidate(): Promise<void> {
    const proposed = await this.stageTool("propose");
    if (!("git" in proposed) || proposed.git.kind !== "stage")
      throw new Error("commit-fixture-stage-unavailable");
    this.write("stage-proposed", proposed);
    if (proposed.git.status === "approval-required")
      await this.waitForStageApproval(proposed.git.proposalId);
    else if (proposed.git.status !== "ready") throw new Error("commit-fixture-stage-refused");
    const staged = await this.stageTool("execute", proposed.git.proposalId);
    if (!("git" in staged) || staged.git.kind !== "stage" || staged.git.status !== "succeeded") {
      throw new Error("commit-fixture-stage-failed");
    }
    this.write("candidate-staged", staged);
  }

  private async stageTool(
    phase: "propose" | "execute",
    proposalId?: string,
  ): Promise<CodingToolResult> {
    const run = this.run;
    if (run === undefined) throw new Error("commit-fixture-run-unavailable");
    const identity = `stage-fixture-${phase}-${run.request.runId}-${String(this.lastControl)}`;
    return await run.toolFacade.execute({
      capability: run.minted.toolFacadeCapability,
      body: JSON.stringify({
        action: "git",
        operation: "stage",
        phase,
        actionId: identity,
        idempotencyKey: identity,
        ...(phase === "propose" ? { paths: [this.input.target] } : { proposalId }),
      }),
    });
  }

  private async waitForStageApproval(proposalId: string): Promise<void> {
    const run = this.run;
    if (run === undefined) throw new Error("commit-fixture-run-unavailable");
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      // Read-only check of the real bridge. Only the mounted UI approval route can activate it.
      if (run.codingToolApprovals.matchesStage?.(run.request.runId, proposalId) === true) return;
      if (this.input.snapshots.get(run.request.runId)?.terminalAt !== undefined) break;
      await setTimeout(25);
    }
    throw new Error("commit-fixture-stage-approval-unavailable");
  }
}

export function createCodingIssueCommitFixture(
  input: CommitFixtureInput,
): CodingIssueCommitFixture {
  return new CommitFixture(input);
}
