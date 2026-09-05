import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import {
  consumeCatalogCursorMatching,
  discardCatalogCursor,
  issueCatalogCursor,
  type CursorBinding,
} from "./catalogToolCursor.js";
import { catalogRequestDigest } from "./catalogToolRequest.js";
import { requireDispatch, sameRef } from "./catalogToolRuntimeAuthority.js";
import type { CatalogBindingState } from "./catalogToolBinder.js";
import type {
  BoundToolInvocation,
  CatalogActionIdentity,
  CatalogToolBudgetReservation,
  CatalogTrustedContext,
} from "./catalogToolPorts.js";

/** One invocation may publish one continuation; all stored bindings remain in the existing registry. */
export class CatalogContinuation {
  public pageSequence = 0;
  private requestNonce: string;
  private issued: string | undefined;
  private previousReservationId: string | undefined;
  public constructor(
    private readonly state: CatalogBindingState,
    private readonly context: CatalogTrustedContext,
    private readonly request: BoundToolInvocation,
    identity: CatalogActionIdentity,
  ) {
    this.requestNonce = identity.idempotencyKey;
  }
  public resume(token: string): void {
    const binding = consumeCatalogCursorMatching(
      this.state.options.invocationRegistry,
      this.context.runId,
      token,
      this.state.options.now(),
      (actual) => {
        this.validate(actual);
      },
    );
    this.previousReservationId = binding.budgetReservationId;
    this.pageSequence = binding.pageSequence;
    this.requestNonce = binding.nonce;
  }
  private validate(binding: CursorBinding): void {
    requireDispatch(
      sameRef(binding.toolRef, this.request.toolRef) &&
        binding.projectionDigest === this.request.projectionDigest &&
        canonicalise(binding.profile) === canonicalise(this.state.projection.profile),
      "invalid",
      "cursor-invalid",
    );
    requireDispatch(
      binding.workspaceIdentity === this.context.workspaceIdentity &&
        binding.workspaceRevision === this.context.workspaceRevision,
      "invalid",
      "cursor-invalid",
    );
    requireDispatch(
      binding.requestDigest === catalogRequestDigest(this.request, this.context, binding.nonce),
      "invalid",
      "cursor-invalid",
    );
  }
  public assertFreshReservation(reservation: CatalogToolBudgetReservation): void {
    requireDispatch(
      reservation.reservationId !== this.previousReservationId,
      "failed",
      "budget-port-failed",
    );
  }
  public issue(reservation: CatalogToolBudgetReservation): string {
    requireDispatch(this.issued === undefined, "invalid", "cursor-invalid");
    const now = this.state.options.now();
    const expiry = Math.min(
      Date.parse(this.context.deadlineAt),
      Date.parse(this.context.authorityExpiresAt),
      now + 30_000,
    );
    const token = this.state.options.mintId();
    this.issued = issueCatalogCursor(
      this.state.options.invocationRegistry,
      this.context.runId,
      {
        toolRef: this.request.toolRef,
        requestDigest: catalogRequestDigest(this.request, this.context, this.requestNonce),
        workspaceIdentity: this.context.workspaceIdentity,
        workspaceRevision: this.context.workspaceRevision,
        profile: this.state.projection.profile,
        projectionDigest: this.request.projectionDigest,
        expiresAt: new Date(expiry).toISOString(),
        budgetReservationId: reservation.reservationId,
        nonce: this.requestNonce,
        pageSequence: this.pageSequence + 1,
      },
      token,
      now,
    );
    return this.issued;
  }
  public owns(cursor: string | null): boolean {
    return cursor === null || cursor === this.issued;
  }
  public discardUnless(cursor: string | null): void {
    if (this.issued !== undefined && this.issued !== cursor)
      discardCatalogCursor(this.state.options.invocationRegistry, this.context.runId, this.issued);
  }
}
