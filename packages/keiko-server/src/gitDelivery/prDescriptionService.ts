import { randomUUID } from "node:crypto";
import { evaluateGitPolicy } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-policy";
import {
  PR_DESCRIPTION_APPLICATION_MAX_AGE_MS,
  isPrDescriptionApplicationStatus,
  type PrDescriptionApplicationStatus,
} from "@oscharko-dev/keiko-contracts/runtime/pr-description-application";
import { evaluateGitPullRequestEffectivePolicy } from "@oscharko-dev/keiko-tools";
import { KEIKO_DEFAULT_PR_POLICY_PACK } from "./prExecution.js";
import { defaultMintableRepoPack } from "./policyPackMintability.js";
import { PrDescriptionApprovals } from "./prDescriptionApproval.js";
import { descriptionFailureReason, logDescription } from "./prDescriptionProjection.js";
import {
  applyDescription,
  assertDescriptionUnchanged,
  reconciledDescriptionStatus,
} from "./prDescriptionEffects.js";
import {
  parsePrDescriptionPreviewRequest,
  prepareDescription,
  prepareDescriptionArtifact,
  readDescriptionBody,
  sameDescriptionContext,
  validDescriptionContext,
} from "./prDescriptionPreparation.js";
import {
  PrDescriptionFailure,
  type PrDescriptionApplicationService,
  type PrDescriptionServiceOptions,
  type PrDescriptionApplicationResult,
  type PreparedPrDescription,
  type PrDescriptionContext,
  type PrDescriptionDraftPreview,
  type PrDescriptionPreview,
} from "./prDescriptionTypes.js";
import type { GitDeliveryIssuedApproval } from "./approvalStore.js";

type ProposalPreparation = (
  context: PrDescriptionContext,
  now: number,
) => Promise<PreparedPrDescription>;

type HeldDescriptionProposal =
  | { readonly kind: "application"; readonly proposal: PreparedPrDescription }
  | { readonly kind: "draft"; readonly preview: PrDescriptionDraftPreview };

export function createPrDescriptionApplicationService(
  options: PrDescriptionServiceOptions,
): PrDescriptionApplicationService {
  return new DescriptionService(options);
}
class DescriptionService implements PrDescriptionApplicationService {
  private readonly proposals = new Map<string, HeldDescriptionProposal>();
  private readonly approvals: PrDescriptionApprovals;
  private lastNow = 0;
  private generation = 0;
  private busy = false;
  public constructor(private readonly options: PrDescriptionServiceOptions) {
    this.approvals = new PrDescriptionApprovals(options.execution.approvalStore);
  }
  private time(): number {
    const now = (this.options.execution.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < this.lastNow)
      throw new PrDescriptionFailure("authority-denied");
    this.lastNow = now;
    return now;
  }
  private admittedContext(): PrDescriptionContext | undefined {
    const context = this.options.context();
    return context === undefined
      ? undefined
      : Object.freeze({ ...context, workspace: Object.freeze({ ...context.workspace }) });
  }
  private generationCurrent(generation: number, context: PrDescriptionContext): boolean {
    return generation === this.generation && this.current(context);
  }
  private current(context: PrDescriptionContext): boolean {
    const live = this.options.context();
    return (
      live !== undefined &&
      sameDescriptionContext(context, live) &&
      validDescriptionContext(context) &&
      validDescriptionContext(live)
    );
  }
  private allowed(proposal: PreparedPrDescription): boolean {
    const packs =
      this.options.execution.policyPacks ?? defaultMintableRepoPack(KEIKO_DEFAULT_PR_POLICY_PACK);
    const base = proposal.review.status.binding.baseRef;
    const policy = evaluateGitPolicy(packs.orgPack, packs.repoPack, {
      actionKind: "pr-update",
      targetBranchName: base,
      activeProviderCapabilities: [],
    });
    return (
      evaluateGitPullRequestEffectivePolicy(policy, base, [], "pr-update").outcome !== "blocked"
    );
  }
  /**
   * B2-8 (wave-3 W3-4 item 3) — releases the reservation `prDescriptionPreparation.ts` places on
   * an `"application"`-kind proposal's snapshot reference. Called at every point such a proposal
   * stops being held, so a retained reference is never left pinned once nothing can apply it.
   */
  private releaseProposalSnapshot(proposal: PreparedPrDescription): void {
    this.options.snapshots.release?.(
      proposal.snapshotReference,
      proposal.context.accessScope,
      proposal.context.correlationId,
    );
  }
  private releaseHeldSnapshot(held: HeldDescriptionProposal | undefined): void {
    if (held?.kind === "application") this.releaseProposalSnapshot(held.proposal);
  }
  private releaseAllHeldSnapshots(): void {
    for (const held of this.proposals.values()) this.releaseHeldSnapshot(held);
  }
  private held(id: string): PreparedPrDescription | undefined {
    const held = this.proposals.get(id);
    if (held?.kind !== "application") return undefined;
    const proposal = held.proposal;
    try {
      if (
        Date.parse(proposal.review.expiresAt) <= this.time() ||
        !this.current(proposal.context) ||
        !this.allowed(proposal)
      )
        return undefined;
      return proposal;
    } catch {
      return undefined;
    }
  }
  public review(id: string): PrDescriptionPreview | undefined {
    const proposal = this.held(id);
    return proposal === undefined ? undefined : structuredClone(proposal.review);
  }
  public holdDraftArtifact(
    artifact: PreparedPrDescription["artifact"],
    now: number,
  ): PrDescriptionDraftPreview | undefined {
    if (!Number.isSafeInteger(now) || now < this.lastNow || artifact.outcome === "failed") {
      return undefined;
    }
    this.lastNow = now;
    const preview = {
      schemaVersion: "1" as const,
      proposalId: randomUUID(),
      expiresAt: new Date(now + PR_DESCRIPTION_APPLICATION_MAX_AGE_MS).toISOString(),
      artifact: structuredClone(artifact),
    };
    this.releaseAllHeldSnapshots();
    this.proposals.clear();
    this.approvals.clear();
    this.proposals.set(preview.proposalId, { kind: "draft", preview });
    return structuredClone(preview);
  }
  public reviewDraft(id: string): PrDescriptionDraftPreview | undefined {
    const held = this.proposals.get(id);
    if (held?.kind !== "draft") return undefined;
    try {
      if (Date.parse(held.preview.expiresAt) <= this.time()) return undefined;
      return structuredClone(held.preview);
    } catch {
      return undefined;
    }
  }
  public async preview(raw: unknown): Promise<PrDescriptionApplicationResult> {
    const request = parsePrDescriptionPreviewRequest(raw);
    if (request === undefined) return { outcome: "blocked", reason: "invalid-request" };
    return this.previewPrepared((context, now) =>
      prepareDescription(this.options, context, request, now),
    );
  }
  public previewArtifact(
    artifact: PreparedPrDescription["artifact"],
  ): Promise<PrDescriptionApplicationResult> {
    return this.previewPrepared((context, now) =>
      prepareDescriptionArtifact(this.options, context, artifact, now),
    );
  }
  private async previewPrepared(
    prepare: ProposalPreparation,
  ): Promise<PrDescriptionApplicationResult> {
    const context = this.admittedContext();
    if (context === undefined || this.busy)
      return { outcome: "blocked", reason: "authority-denied" };
    const generation = ++this.generation;
    this.busy = true;
    // Tracks a proposal once `prepare` has returned it: `prDescriptionPreparation.ts` has already
    // reserved its snapshot reference by that point, so a validation failure below — after
    // preparation succeeded but before this proposal is ever stored in `this.proposals` — must
    // release that reservation itself; nothing else will (wave-3 W3-4 item 3).
    let proposal: PreparedPrDescription | undefined;
    try {
      if (!this.current(context)) throw new PrDescriptionFailure("authority-denied");
      proposal = await prepare(context, this.time());
      if (!this.generationCurrent(generation, context))
        throw new PrDescriptionFailure("authority-denied");
      if (!this.allowed(proposal)) throw new PrDescriptionFailure("policy-blocked");
      await assertDescriptionUnchanged(this.options, proposal, () => this.current(context));
      if (generation !== this.generation || Date.parse(proposal.review.expiresAt) <= this.time())
        throw new PrDescriptionFailure("expired");
      this.releaseAllHeldSnapshots();
      this.proposals.clear();
      this.approvals.clear();
      this.proposals.set(proposal.review.proposalId, { kind: "application", proposal });
      logDescription(this.options, context, "preview", "approval-required", proposal.review.status);
      return { outcome: "preview", preview: structuredClone(proposal.review) };
    } catch (error) {
      if (proposal !== undefined) this.releaseProposalSnapshot(proposal);
      return this.failure(context, "preview", error);
    } finally {
      this.busy = false;
    }
  }
  public issueApproval(id: string): GitDeliveryIssuedApproval | undefined {
    const proposal = this.held(id);
    if (proposal === undefined || this.busy) return undefined;
    const issued = this.approvals.issue(proposal, this.time());
    logDescription(
      this.options,
      proposal.context,
      "approval",
      "approval-required",
      proposal.review.status,
    );
    return issued;
  }
  public matchesApproval(id: string): boolean {
    const proposal = this.held(id);
    return proposal !== undefined && this.approvals.matches(proposal, this.time());
  }
  public consumeApproval(id: string): object | undefined {
    const proposal = this.held(id);
    return proposal === undefined || this.busy
      ? undefined
      : this.approvals.consume(proposal, this.time());
  }
  public async executeApproved(
    id: string,
    lease: object,
    guard?: { readonly check: () => boolean; readonly signal?: AbortSignal },
  ): Promise<PrDescriptionApplicationResult> {
    const proposal = this.held(id);
    if (proposal === undefined || this.busy)
      return { outcome: "blocked", reason: "approval-invalid" };
    const requirement = this.approvals.redeem(proposal, lease);
    if (requirement === undefined) return { outcome: "blocked", reason: "approval-invalid" };
    this.releaseProposalSnapshot(proposal);
    this.proposals.delete(id);
    this.busy = true;
    const generation = this.generation;
    const check = (): boolean => this.executionCurrent(proposal, generation, guard);
    const effect = guardedProposal(proposal, guard?.signal);
    try {
      if (!check()) throw new PrDescriptionFailure("authority-denied");
      const confirmed = await applyDescription(this.options, effect, requirement, check, () =>
        this.time(),
      );
      if (!check()) throw new PrDescriptionFailure("authority-denied");
      return await this.observe(effect.context, proposal.review.status, confirmed, "apply", check);
    } catch (error) {
      return this.failure(proposal.context, "apply", error);
    } finally {
      this.busy = false;
    }
  }
  private executionCurrent(
    proposal: PreparedPrDescription,
    generation: number,
    guard?: { readonly check: () => boolean; readonly signal?: AbortSignal },
  ): boolean {
    return (
      this.generation === generation &&
      this.current(proposal.context) &&
      this.allowed(proposal) &&
      Date.parse(proposal.review.expiresAt) > this.time() &&
      guard?.signal?.aborted !== true &&
      (guard?.check() ?? true)
    );
  }
  public async reconcile(): Promise<PrDescriptionApplicationResult> {
    const context = this.admittedContext();
    if (context === undefined || this.busy)
      return { outcome: "blocked", reason: "authority-denied" };
    this.busy = true;
    try {
      if (!this.current(context)) throw new PrDescriptionFailure("authority-denied");
      const previous = this.options.readStatus(context);
      if (!isPrDescriptionApplicationStatus(previous))
        throw new PrDescriptionFailure("invalid-request");
      if (
        previous.binding.repository.toLowerCase() !== context.repository.toLowerCase() ||
        previous.binding.prNumber !== context.prNumber
      )
        throw new PrDescriptionFailure("invalid-request");
      return await this.observe(context, previous, false, "reconcile", () => this.current(context));
    } catch (error) {
      return this.failure(context, "reconcile", error);
    } finally {
      this.busy = false;
    }
  }
  private async observe(
    context: PrDescriptionContext,
    previous: PrDescriptionApplicationStatus,
    confirmed: boolean,
    phase: "apply" | "reconcile",
    check: () => boolean,
  ): Promise<PrDescriptionApplicationResult> {
    const started = this.time();
    const remote = await readDescriptionBody(this.options, context);
    const now = this.time();
    if (!check() || now - started >= 60_000) throw new PrDescriptionFailure("authority-denied");
    const status = reconciledDescriptionStatus(previous, remote, confirmed, now);
    if (!this.options.recordStatus(context, status))
      throw new PrDescriptionFailure("authority-denied");
    logDescription(this.options, context, phase, status.reason, status);
    return { outcome: "observed", status };
  }
  private failure(
    context: PrDescriptionContext,
    phase: "preview" | "apply" | "reconcile",
    error: unknown,
  ): PrDescriptionApplicationResult {
    const reason = descriptionFailureReason(error);
    logDescription(this.options, context, phase, reason, undefined, error);
    return { outcome: "blocked", reason };
  }
  public invalidate(): void {
    this.generation += 1;
    this.releaseAllHeldSnapshots();
    this.proposals.clear();
    this.approvals.clear();
  }
}

function guardedProposal(
  proposal: PreparedPrDescription,
  signal: AbortSignal | undefined,
): PreparedPrDescription {
  if (signal === undefined) return proposal;
  const combined =
    proposal.context.signal === undefined
      ? signal
      : AbortSignal.any([proposal.context.signal, signal]);
  return {
    ...proposal,
    context: { ...proposal.context, signal: combined },
    captureInput: { ...proposal.captureInput, signal: combined },
  };
}
